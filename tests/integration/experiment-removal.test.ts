import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { actionFixture } from "../fixtures/experiment-actions";
import { buildServer } from "../../apps/control-plane/src/server";
for (const baselineRemoved of [false, true])
  test(`removal erases the entire experiment and preserves anonymous mixed comparison, baseline removed=${baselineRemoved}`, async () => {
    const f = await actionFixture(),
      app = buildServer(f.platform);
    try {
      await app.ready();
      f.terminal();
      const sentinel = f.additional(),
        other = sentinel.runs[0].id;
      const comparison = f.platform.controlUi.createComparison({
        baselineRunId: baselineRemoved ? f.runIds[0] : other,
        variantRunIds: [other, ...f.runIds]
      });
      const file = path.join(f.platform.storage.root, f.runIds[0], "orphan.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "owned result");
      const preserved = JSON.stringify(f.platform.repositories.getRun(other));
      const a = f.platform.experimentActions,
        body = {
          contractVersion: "experiment-action.v1",
          kind: "REMOVE",
          confirm: true,
          expectedRevision: a.eligibility(f.submitted.id).executionRevision
        };
      const accepted = a.submit(f.submitted.id, body, "remove-all");
      await a.idle();
      assert.equal(a.get(accepted.id).status, "SUCCEEDED");
      assert.equal(f.platform.repositories.getExperiment(f.submitted.id), undefined);
      assert.equal(fs.existsSync(file), false);
      assert.equal(JSON.stringify(f.platform.repositories.getRun(other)), preserved);
      assert.equal(a.submit(f.submitted.id, body, "remove-all").id, accepted.id);
      const receipt = JSON.stringify(a.repository.get(accepted.id));
      for (const id of [f.submitted.id, ...f.runIds]) assert.ok(!receipt.includes(id));
      const mixed = f.platform.controlUi.getComparison(comparison.id);
      assert.equal(mixed.unavailableMemberCount, 4);
      assert.deepEqual(mixed.selectionPage.runIds, [other]);
      assert.equal(mixed.baselineRunId, baselineRemoved ? undefined : other);
      assert.equal(mixed.baselineRemoved, baselineRemoved);
      const tables = [
        "experiments",
        "variants",
        "runs",
        "experiment_execution",
        "control_experiments",
        "control_run_metadata",
        "control_previews",
        "control_comparisons",
        "control_dashboard_contexts",
        "idempotency_keys",
        "control_command_results",
        "experiment_actions"
      ];
      for (const table of tables)
        for (const row of f.platform.database.db.prepare(`SELECT * FROM ${table}`).all()) {
          const value = JSON.stringify(row);
          for (const id of [f.submitted.id, ...f.runIds])
            assert.ok(!value.includes(id), `${table} retained ${id}`);
        }
      for (const url of [
        `/api/v1/experiments/${f.submitted.id}`,
        `/api/v1/runs/${f.runIds[0]}`,
        `/api/v1/history/runs/${f.runIds[0]}`
      ])
        assert.equal((await app.inject({ method: "GET", url })).statusCode, 404, url);
    } finally {
      await app.close();
      f.close();
    }
  });
test("queued incomplete schedule can be removed while active execution is rejected", async () => {
  const f = await actionFixture();
  try {
    const a = f.platform.experimentActions;
    f.platform.database.db
      .prepare("UPDATE experiment_execution SET schedule_json=NULL WHERE experiment_id=?")
      .run(f.submitted.id);
    f.platform.database.db
      .prepare("UPDATE control_experiments SET scenario_snapshot='null' WHERE experiment_id=?")
      .run(f.submitted.id);
    assert.equal(a.eligibility(f.submitted.id).remove.allowed, true);
    f.platform.database.db.prepare("UPDATE runs SET state='MEASURING' WHERE id=?").run(f.runIds[0]);
    assert.throws(
      () =>
        a.submit(
          f.submitted.id,
          {
            contractVersion: "experiment-action.v1",
            kind: "REMOVE",
            confirm: true,
            expectedRevision: a.repository.currentRevision(f.submitted.id)
          },
          "active-remove"
        ),
      /experiment_active/
    );
    f.platform.database.db.prepare("UPDATE runs SET state='QUEUED' WHERE id=?").run(f.runIds[0]);
    const action = a.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "REMOVE",
        confirm: true,
        expectedRevision: a.repository.currentRevision(f.submitted.id)
      },
      "queued-remove"
    );
    await a.idle();
    assert.equal(a.get(action.id).status, "SUCCEEDED");
  } finally {
    f.close();
  }
});

test("failed removal remains discoverable after refresh, scrubs prior failures and preserves independent reports and inputs", async () => {
  const f = await actionFixture(),
    app = buildServer(f.platform);
  try {
    await app.ready();
    f.terminal();
    const a = f.platform.experimentActions,
      revision = a.repository.currentRevision(f.submitted.id),
      prior = a.repository.reserve(f.submitted.id, "RERUN", revision, "rejected-before-remove");
    a.repository.fail(prior.id, "experiment_input_unavailable", true);
    const input = path.join(f.root, "independent-input.txt");
    fs.writeFileSync(input, "preserve source");
    const report = { id: "independent-report", kind: "READ_ONLY", notes: "independent result" };
    f.platform.database.db
      .prepare("INSERT INTO database_reports(id,state,document) VALUES(?,'COMPLETED',?)")
      .run(report.id, JSON.stringify(report));
    const admin = a.metricAdmin,
      remove = admin.delete.bind(admin);
    let failed = true;
    admin.delete = async (s) => {
      if (failed) throw Error("experiment_metrics_delete_failed");
      await remove(s);
    };
    const action = a.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "REMOVE",
        confirm: true,
        expectedRevision: revision
      },
      "partial-remove"
    );
    await a.idle();
    assert.equal(a.get(action.id).status, "FAILED");
    assert.equal(f.platform.repositories.listRuns(f.submitted.id).length, 4);
    const history = await app.inject({ method: "GET", url: "/api/v1/history/runs" });
    assert.ok(history.json().actions.some((x) => x.id === action.id));
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/v1/runs/${f.runIds[0]}` })).statusCode,
      409
    );
    failed = false;
    a.retry(
      action.id,
      { contractVersion: "experiment-action.v1", confirm: true },
      "continue-removal"
    );
    await a.idle();
    assert.equal(a.get(action.id).status, "SUCCEEDED");
    assert.equal(a.repository.get(prior.id), undefined);
    assert.equal(fs.readFileSync(input, "utf8"), "preserve source");
    assert.equal(
      f.platform.database.db
        .prepare("SELECT document FROM database_reports WHERE id=?")
        .get(report.id).document,
      JSON.stringify(report)
    );
  } finally {
    await app.close();
    f.close();
  }
});
