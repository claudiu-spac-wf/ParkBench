import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createSeedFixture } from "../helpers/seed";
import { actionFixture } from "../fixtures/experiment-actions";
import { buildServer } from "../../apps/control-plane/src/server";
const service = (f: any) => f.platform.experimentActions;
const request = (revision: string) => ({
  contractVersion: "experiment-action.v1",
  kind: "RERUN",
  confirm: true,
  expectedRevision: revision
});
test("whole experiment rerun preserves exact IDs/names/frozen choices and removes old execution artifacts", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const before = f.platform.repositories.listRuns(f.submitted.id);
    const expected = before.map((r) => ({
      id: r.id,
      name: r.name,
      variant: r.variantId,
      repetition: r.repetition,
      configuration: r.environmentSnapshot?.effectiveConfiguration,
      scenario: r.environmentSnapshot?.scenario,
      iops: r.environmentSnapshot?.databaseIops
    }));
    const artifact = path.join(f.platform.storage.root, f.runIds[0], "old-orphan.json");
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, "old");
    const a = service(f).submit(
      f.submitted.id,
      request(service(f).eligibility(f.submitted.id).executionRevision),
      "reset-all"
    );
    await service(f).idle();
    assert.equal(service(f).get(a.id).status, "SUCCEEDED");
    const after = f.platform.repositories.listRuns(f.submitted.id);
    assert.deepEqual(
      after.map((r: any) => ({
        id: r.id,
        name: r.name,
        variant: r.variantId,
        repetition: r.repetition,
        configuration: r.environmentSnapshot?.effectiveConfiguration,
        scenario: r.environmentSnapshot?.scenario,
        iops: r.environmentSnapshot?.databaseIops
      })),
      expected
    );
    assert.ok(
      after.every(
        (r) =>
          r.state === "QUEUED" &&
          !r.failureCode &&
          !r.finishedAt &&
          r.measurementValidity === "PENDING"
      )
    );
    assert.notEqual(after[0].executionRevision, before[0].executionRevision);
    assert.equal(fs.existsSync(artifact), false);
    assert.equal(f.platform.repositories.listEvents(f.runIds[0]).length, 0);
  } finally {
    await service(f)?.idle();
    f.close();
  }
});
test("missing saved settings and active execution reject before deleting old results", async () => {
  const f = await actionFixture();
  try {
    const a = service(f);
    const revision = a.eligibility(f.submitted.id).executionRevision;
    f.platform.database.db.prepare("UPDATE runs SET state='MEASURING' WHERE id=?").run(f.runIds[0]);
    assert.throws(() => a.submit(f.submitted.id, request(revision), "active"), /experiment_active/);
    f.terminal();
    f.platform.database.db
      .prepare("UPDATE control_experiments SET scenario_snapshot='null' WHERE experiment_id=?")
      .run(f.submitted.id);
    f.platform.database.db
      .prepare("UPDATE experiment_execution SET schedule_json=NULL WHERE experiment_id=?")
      .run(f.submitted.id);
    assert.throws(
      () => a.submit(f.submitted.id, request(revision), "missing-settings"),
      /schedule_incomplete/
    );
    assert.equal(f.platform.repositories.getRun(f.runIds[0])?.state, "FAILED");
  } finally {
    f.close();
  }
});

test("the saved schedule survives current source/default/catalog edits and rejects corrupted subsets before deletion", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const a = f.platform.experimentActions,
      db = f.platform.database.db;
    const original: any = db
      .prepare("SELECT schedule_json FROM experiment_execution WHERE experiment_id=?")
      .get(f.submitted.id);
    const snapshot = JSON.parse(original.schedule_json);
    const altered = structuredClone(snapshot);
    altered.runs.pop();
    db.prepare("UPDATE experiment_execution SET schedule_json=? WHERE experiment_id=?").run(
      JSON.stringify(altered),
      f.submitted.id
    );
    assert.equal(a.eligibility(f.submitted.id).rerun.allowed, false);
    assert.equal(f.platform.repositories.getRun(f.runIds[0])?.state, "FAILED");
    db.prepare("UPDATE experiment_execution SET schedule_json=? WHERE experiment_id=?").run(
      original.schedule_json,
      f.submitted.id
    );
    db.prepare(
      "UPDATE control_experiments SET scenario_snapshot='null',request_json='{}',matrix_spec='{}' WHERE experiment_id=?"
    ).run(f.submitted.id);
    const action = a.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: a.repository.currentRevision(f.submitted.id)
      },
      "frozen"
    );
    await a.idle();
    assert.equal(a.get(action.id).status, "SUCCEEDED");
    assert.deepEqual(
      f.platform.repositories.getRun(f.runIds[0])?.environmentSnapshot?.scenario,
      snapshot.runs[0].environment.scenario
    );
  } finally {
    f.close();
  }
});

test("legacy frozen numeric IOPS remains independent of the current catalog revision", async () => {
  const { resolveDatabaseIops } = await import("../../packages/contracts/src/database-iops");
  const f = await actionFixture();
  try {
    f.terminal();
    const db = f.platform.database.db,
      row: any = db
        .prepare("SELECT schedule_json FROM experiment_execution WHERE experiment_id=?")
        .get(f.submitted.id),
      snapshot = JSON.parse(row.schedule_json),
      frozen = resolveDatabaseIops("sata-ssd", "database-iops-presets.v1");
    for (const run of snapshot.runs) run.environment.databaseIops = frozen;
    db.prepare("UPDATE experiment_execution SET schedule_json=? WHERE experiment_id=?").run(
      JSON.stringify(snapshot),
      f.submitted.id
    );
    const a = f.platform.experimentActions,
      action = a.submit(
        f.submitted.id,
        {
          contractVersion: "experiment-action.v1",
          kind: "RERUN",
          confirm: true,
          expectedRevision: a.repository.currentRevision(f.submitted.id)
        },
        "legacy-catalog"
      );
    await a.idle();
    assert.equal(a.get(action.id).status, "SUCCEEDED");
    for (const run of f.platform.repositories.listRuns(f.submitted.id))
      assert.deepEqual(run.environmentSnapshot?.databaseIops, frozen);
    assert.equal(frozen.writeIopsPerDevice, 90000);
  } finally {
    f.close();
  }
});
test("missing or incompatible saved inputs fail prevalidation without changing old results", async () => {
  for (const mode of ["missing-archive", "incompatible-archive", "invalid-seed"]) {
    const f = await actionFixture();
    try {
      f.terminal();
      const a = f.platform.experimentActions,
        db = f.platform.database.db,
        row: any = db
          .prepare("SELECT schedule_json FROM experiment_execution WHERE experiment_id=?")
          .get(f.submitted.id),
        snapshot = JSON.parse(row.schedule_json),
        seed = path.join(f.root, "seed"),
        archive = path.join(f.root, "archive.zip");
      if (mode === "invalid-seed") fs.mkdirSync(seed);
      else createSeedFixture(f.root, "seed");
      if (mode !== "missing-archive") fs.writeFileSync(archive, "incompatible archive");
      snapshot.experiment.inputs = JSON.stringify({
        ...JSON.parse(snapshot.experiment.inputs),
        seed,
        applicationArchive: archive
      });
      db.prepare("UPDATE experiment_execution SET schedule_json=? WHERE experiment_id=?").run(
        JSON.stringify(snapshot),
        f.submitted.id
      );
      (a as any).runtime.testMode = false;
      const action = a.submit(
        f.submitted.id,
        {
          contractVersion: "experiment-action.v1",
          kind: "RERUN",
          confirm: true,
          expectedRevision: a.repository.currentRevision(f.submitted.id)
        },
        "bad-input"
      );
      await a.idle();
      assert.equal(a.get(action.id).failure?.code, "experiment_input_unavailable");
      assert.equal(a.repository.isFenced(f.submitted.id), false);
      assert.equal(f.platform.repositories.getRun(f.runIds[0])?.state, "FAILED");
    } finally {
      f.close();
    }
  }
});
