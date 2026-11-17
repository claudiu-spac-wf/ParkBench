import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { actionFixture } from "../fixtures/experiment-actions";
import { executionScope } from "../../apps/control-plane/src/db/execution";
import { deferred } from "../fixtures/experiment-actions";
import { buildServer } from "../../apps/control-plane/src/server";
import os from "node:os";
import { createPlatform } from "../../apps/control-plane/src/platform";

for (const failure of ["temporary_capacity", "invalid_inputs"])
  test(`selected rerun ${failure} does not rewrite completed sibling queue metadata`, async () => {
    const f = await actionFixture();
    try {
      f.terminal();
      const p = f.platform,
        a = p.experimentActions,
        target = f.runIds[3];
      const accepted = a.submitRun(
        target,
        {
          contractVersion: "experiment-action.v1",
          kind: "RERUN",
          confirm: true,
          expectedRevision: a.runEligibility(target).executionRevision
        },
        `selected-block-${failure}`
      );
      await a.idle();
      assert.equal(a.get(accepted.id).status, "SUCCEEDED");
      p.controlUi.listQueue();
      const before = f.runIds.slice(0, 3).map((id) => p.controlRepository.getRunMetadata(id));
      (p.controlUi as any).preflightExperimentInputs = async () => {
        throw Error(
          failure === "temporary_capacity"
            ? "temporary_host_capacity"
            : "experiment_input_unavailable"
        );
      };
      const result = await p.controlUi.startQueue();
      assert.equal(result.started, undefined);
      assert.deepEqual(
        f.runIds.slice(0, 3).map((id) => p.controlRepository.getRunMetadata(id)),
        before
      );
      assert.ok(p.controlRepository.getRunMetadata(target)!.blockedReason);
    } finally {
      await f.platform.close();
      f.close();
    }
  });

test("a later individual cleanup seals the parent aggregate version separately from its older selected run token", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const a = f.platform.experimentActions;
    const submit = (runId: string, key: string) =>
      a.submitRun(
        runId,
        {
          contractVersion: "experiment-action.v1",
          kind: "RERUN",
          confirm: true,
          expectedRevision: a.runEligibility(runId).executionRevision
        },
        key
      );
    submit(f.runIds[0], "first-independent-token");
    await a.idle();
    f.terminal();
    const parentRevision = a.repository.currentRevision(f.submitted.id);
    assert.notEqual(a.runEligibility(f.runIds[1]).executionRevision, parentRevision);
    const admin = a.metricAdmin as any;
    admin.quiesce = async () => {
      admin.client.samples.push({
        metricName: "late_parent_aggregate",
        value: 1,
        timestamp: Date.now(),
        labels: { experiment_id: f.submitted.id, execution_revision: parentRevision }
      });
    };
    const accepted = submit(f.runIds[1], "second-independent-token");
    await a.idle();
    assert.equal(a.get(accepted.id).status, "SUCCEEDED");
    assert.equal(admin.client.samples.length, 0);
    assert.equal(f.platform.repositories.getRun(f.runIds[0])!.executionRevision, parentRevision);
  } finally {
    await f.platform.experimentActions.idle();
    f.close();
  }
});

test("normal queue dispatch executes one replacement and skips all nineteen terminal siblings", async () => {
  const f = await actionFixture({ phaseScale: 0 }, ":memory:", {
    values: [500, 1000],
    repetitions: 10
  });
  try {
    f.terminal();
    const platform = f.platform,
      actions = platform.experimentActions,
      target = f.runIds.at(-1)!;
    const before = platform.repositories.listRuns(f.submitted.id).slice(0, -1);
    const execute = platform.coordinator.executeRun.bind(platform.coordinator),
      executed: string[] = [];
    platform.coordinator.executeRun = async (run, behavior) => {
      executed.push(run.id);
      return execute(run, behavior);
    };
    const accepted = actions.submitRun(
      target,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: actions.runEligibility(target).executionRevision
      },
      "normal-one-run-dispatch"
    );
    await actions.idle();
    assert.equal(actions.get(accepted.id).status, "SUCCEEDED");
    // An invalid completed sibling configuration cannot replace the selected preflight input.
    const sibling = platform.repositories.getRun(f.runIds[0])!;
    const snapshot = sibling.environmentSnapshot as any;
    snapshot.effectiveConfiguration = { "-B": -1 };
    platform.repositories.saveRun(sibling);
    before[0] = platform.repositories.getRun(sibling.id)!;
    const result = await platform.controlUi.startQueue();
    assert.equal(result.started, f.submitted.id);
    const deadline = Date.now() + 10000;
    while (platform.coordinator.isExperimentActive(f.submitted.id) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(platform.coordinator.isExperimentActive(f.submitted.id), false);
    assert.deepEqual(executed, [target]);
    // The zero-duration fake fixture has no measurement coverage. It still
    // exercises normal dispatch/finalization rather than synthesizing success.
    assert.equal(platform.repositories.getRun(target)!.state, "INCOMPLETE");
    assert.ok(platform.repositories.getRun(target)!.finishedAt);
    assert.deepEqual(platform.repositories.listRuns(f.submitted.id).slice(0, -1), before);
  } finally {
    await f.platform.experimentActions.idle();
    await f.platform.close();
    f.close();
  }
});

test("upgrade and repeated platform restart recover one selected run without replacing sibling revisions or comparisons", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-individual-restart-"));
  const file = path.join(root, "state.sqlite"),
    f = await actionFixture({}, file, { values: [500, 1000], repetitions: 10 });
  const entered = deferred(),
    gate = deferred();
  let current = f.platform;
  try {
    f.terminal();
    const target = f.runIds[0],
      sibling = f.runIds[1],
      before = current.repositories.listRuns(f.submitted.id);
    const affected = current.controlUi.createComparison({ variantRunIds: [target, sibling] });
    const unaffected = current.controlUi.createComparison({ variantRunIds: [sibling] });
    // Simulate an existing installation before the additive per-run migration.
    current.database.db.exec("DROP TABLE run_execution");
    await current.close();
    current = createPlatform({ ...f.platform.config, dbPath: file }, { testMode: true });
    await current.startupRecovery;
    assert.deepEqual(
      current.repositories.listRuns(f.submitted.id).map((r) => r.executionRevision),
      before.map((r) => r.executionRevision)
    );
    const actions = current.experimentActions;
    actions.metricAdmin.quiesce = async () => {
      entered.resolve();
      await gate.promise;
    };
    const body = {
      contractVersion: "experiment-action.v1",
      kind: "RERUN",
      confirm: true,
      expectedRevision: actions.runEligibility(target).executionRevision
    };
    const accepted = actions.submitRun(target, body, "individual-restart");
    await entered.promise;
    const replacement = actions.repository.get(accepted.id)!.replacementRevision;
    const closing = current.close();
    gate.resolve();
    await closing;
    current = createPlatform({ ...f.platform.config, dbPath: file }, { testMode: true });
    await current.startupRecovery;
    await current.experimentActions.idle();
    const after = current.repositories.listRuns(f.submitted.id);
    assert.equal(current.experimentActions.get(accepted.id).status, "SUCCEEDED");
    assert.equal(after.filter((r) => r.state === "QUEUED").length, 1);
    assert.equal(after[0].executionRevision, replacement);
    assert.deepEqual(after.slice(1), before.slice(1));
    assert.throws(
      () => current.controlUi.getComparison(affected.id),
      /unavailable_experiment_rerun/
    );
    assert.equal(current.controlUi.getComparison(unaffected.id).id, unaffected.id);
    await current.close();
    current = createPlatform({ ...f.platform.config, dbPath: file }, { testMode: true });
    await current.startupRecovery;
    assert.deepEqual(current.repositories.listRuns(f.submitted.id), after);
    assert.throws(
      () => current.controlUi.getComparison(affected.id),
      /unavailable_experiment_rerun/
    );
    assert.equal(current.controlUi.getComparison(unaffected.id).id, unaffected.id);
    assert.equal(
      current.experimentActions.submitRun(target, body, "individual-restart").id,
      accepted.id
    );
  } finally {
    gate.resolve();
    await current.close();
    await f.platform.close();
    f.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("replacement projects stay distinct when long run names share the same truncated prefix", async () => {
  const f = await actionFixture({}, ":memory:", {
    values: [500, 1000],
    repetitions: 2,
    runName: "a".repeat(48)
  });
  try {
    f.terminal();
    const a = f.platform.experimentActions;
    const admitted = a.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: a.eligibility(f.submitted.id).executionRevision
      },
      "long-private-projects"
    );
    await a.idle();
    assert.equal(a.get(admitted.id).status, "SUCCEEDED");
    const names = f.platform.repositories.listRuns(f.submitted.id).map((r) => r.composeProject);
    assert.equal(new Set(names).size, 4);
    assert.ok(names.every((n) => n.length <= 63));
  } finally {
    await f.platform.experimentActions.idle();
    f.close();
  }
});

test("missing sibling legacy settings do not prevent rerunning a complete selected schedule", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const a = f.platform.experimentActions,
      target = f.runIds[0],
      db = f.platform.database.db;
    const snapshot = JSON.parse(
      (
        db
          .prepare("SELECT schedule_json FROM experiment_execution WHERE experiment_id=?")
          .get(f.submitted.id) as any
      ).schedule_json
    );
    delete snapshot.runs[1].environment.databaseIops;
    db.prepare("UPDATE experiment_execution SET schedule_json=? WHERE experiment_id=?").run(
      JSON.stringify(snapshot),
      f.submitted.id
    );
    assert.equal(a.eligibility(f.submitted.id).rerun.allowed, false);
    assert.equal(a.runEligibility(target).rerun.allowed, true);
    const before = JSON.stringify(f.platform.repositories.getRun(f.runIds[1]));
    const admitted = a.submitRun(
      target,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: a.runEligibility(target).executionRevision
      },
      "selected-complete-legacy"
    );
    await a.idle();
    assert.equal(a.get(admitted.id).status, "SUCCEEDED");
    assert.equal(JSON.stringify(f.platform.repositories.getRun(f.runIds[1])), before);
    const retained = JSON.parse(
      (
        db
          .prepare("SELECT schedule_json FROM experiment_execution WHERE experiment_id=?")
          .get(f.submitted.id) as any
      ).schedule_json
    );
    assert.equal(retained.runs.length, 4);
    assert.equal(retained.runs[1].environment.databaseIops, undefined);
  } finally {
    await f.platform.experimentActions.idle();
    f.close();
  }
});

test("one of twenty reruns preserves nineteen sibling results, revisions, artifacts, samples and comparisons", async () => {
  const f = await actionFixture({}, ":memory:", { values: [500, 1000], repetitions: 10 });
  try {
    f.terminal();
    const actions = f.platform.experimentActions as any,
      target = f.runIds[0],
      other = f.runIds[1];
    const before = f.platform.repositories.listRuns(f.submitted.id),
      siblingBytes = before.slice(1).map((r) => JSON.stringify(r));
    const oldRevision = before[0].executionRevision;
    const affected = f.platform.controlUi.createComparison({
      baselineRunId: target,
      variantRunIds: [other]
    });
    const unaffected = f.platform.controlUi.createComparison({ variantRunIds: f.runIds.slice(1) });
    for (const id of [target, other]) {
      fs.mkdirSync(path.join(f.platform.storage.root, id), { recursive: true });
      fs.writeFileSync(path.join(f.platform.storage.root, id, "orphan.json"), "old result");
    }
    const admin = actions.metricAdmin;
    for (const id of f.runIds)
      admin.client.samples.push({
        metricName: "scope_test",
        type: "gauge",
        value: 7,
        timestamp: Date.now(),
        labels: { run_id: id, experiment_id: f.submitted.id, execution_revision: oldRevision }
      });
    admin.client.samples.push({
      metricName: "raw_scope",
      type: "gauge",
      value: 1,
      timestamp: Date.now(),
      labels: {
        container_label_parkbench_run_id: other,
        container_label_parkbench_experiment_id: f.submitted.id,
        container_label_parkbench_execution_revision: oldRevision
      }
    });
    admin.client.samples.push({
      metricName: "derived_parent",
      type: "gauge",
      value: 20,
      timestamp: Date.now(),
      labels: { experiment_id: f.submitted.id, execution_revision: oldRevision }
    });
    const eligibility = actions.runEligibility(target);
    assert.equal(eligibility.runCount, 1);
    assert.equal(eligibility.rerun.allowed, true);
    const body = {
      contractVersion: "experiment-action.v1",
      kind: "RERUN",
      confirm: true,
      expectedRevision: eligibility.executionRevision
    };
    const admitted = actions.submitRun(target, body, "one-of-twenty");
    await actions.idle();
    assert.equal(actions.get(admitted.id).status, "SUCCEEDED");
    const after = f.platform.repositories.listRuns(f.submitted.id);
    assert.deepEqual(
      after.slice(1).map((r) => JSON.stringify(r)),
      siblingBytes
    );
    assert.equal(after.filter((r) => r.state === "QUEUED").length, 1);
    assert.equal(after[0].id, target);
    assert.equal(after[0].name, before[0].name);
    assert.notEqual(after[0].executionRevision, oldRevision);
    assert.deepEqual(
      after[0].environmentSnapshot?.effectiveConfiguration,
      before[0].environmentSnapshot?.effectiveConfiguration
    );
    assert.equal(fs.existsSync(path.join(f.platform.storage.root, target)), false);
    assert.equal(
      fs.readFileSync(path.join(f.platform.storage.root, other, "orphan.json"), "utf8"),
      "old result"
    );
    assert.equal(admin.client.samples.length, 20);
    assert.ok(
      admin.client.samples.every(
        (s: any) => s.labels.run_id !== target && s.metricName !== "derived_parent"
      )
    );
    assert.throws(
      () => f.platform.controlUi.getComparison(affected.id),
      /unavailable_experiment_rerun/
    );
    assert.equal(f.platform.controlUi.getComparison(unaffected.id).id, unaffected.id);
    assert.equal(actions.submitRun(target, body, "one-of-twenty").id, admitted.id);
    assert.throws(() => actions.submitRun(other, body, "one-of-twenty"), /idempotency_conflict/);
    assert.throws(
      () =>
        executionScope.run({ runId: target, revision: oldRevision }, () =>
          f.platform.artifacts.write(target, "log", "late.log", "late", "text")
        ),
      /revision_stale/
    );
    executionScope.run({ runId: other, revision: oldRevision }, () =>
      f.platform.artifacts.write(other, "log", "current.log", "sibling", "text")
    );
    // Whole scope remains usable after per-run revisions diverge.
    f.terminal();
    assert.throws(
      () => actions.submit(f.submitted.id, body, "stale-whole-after-one"),
      /revision_stale/
    );
    const whole = actions.submit(
      f.submitted.id,
      { ...body, expectedRevision: actions.eligibility(f.submitted.id).executionRevision },
      "whole-after-one"
    );
    await actions.idle();
    assert.equal(actions.get(whole.id).status, "SUCCEEDED");
    assert.equal(
      f.platform.repositories.listRuns(f.submitted.id).filter((r) => r.state === "QUEUED").length,
      20
    );
    assert.equal(
      new Set(f.platform.repositories.listRuns(f.submitted.id).map((r) => r.executionRevision))
        .size,
      1
    );
  } finally {
    await f.platform.experimentActions.idle();
    f.close();
  }
});

test("pending individual cleanup fences only its source readers/publications and duplicate API admission remains available", async () => {
  const f = await actionFixture(),
    app = buildServer(f.platform),
    gate = deferred(),
    entered = deferred();
  try {
    f.terminal();
    const a = f.platform.experimentActions as any,
      target = f.runIds[0],
      other = f.runIds[1];
    const admin = a.metricAdmin,
      remove = admin.delete.bind(admin);
    admin.delete = async (s: string[]) => {
      entered.resolve();
      await gate.promise;
      await remove(s);
    };
    const eligible = await app.inject({ method: "GET", url: `/api/v1/runs/${target}/actions` });
    assert.equal(eligible.statusCode, 200);
    const body = {
      contractVersion: "experiment-action.v1",
      kind: "RERUN",
      confirm: true,
      expectedRevision: eligible.json().executionRevision
    };
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${target}/actions`,
      headers: { "idempotency-key": "pending-one" },
      payload: body
    });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.headers["cache-control"], "no-store");
    assert.ok(accepted.headers.location);
    await entered.promise;
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${target}/actions`,
      headers: { "idempotency-key": "pending-one" },
      payload: body
    });
    assert.equal(duplicate.statusCode, 202);
    assert.equal(duplicate.json().id, accepted.json().id);
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/v1/runs/${target}/actions` })).statusCode,
      200
    );
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/v1/runs/${target}` })).statusCode,
      409
    );
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/v1/runs/${other}` })).statusCode,
      200
    );
    const sibling = f.platform.repositories.getRun(other)!;
    executionScope.run({ runId: other, revision: sibling.executionRevision! }, () =>
      f.platform.artifacts.write(other, "log", "during.txt", "sibling", "text")
    );
    assert.throws(
      () =>
        executionScope.run({ runId: target, revision: body.expectedRevision }, () =>
          f.platform.artifacts.write(target, "log", "during.txt", "old", "text")
        ),
      /action_in_progress/
    );
    gate.resolve();
    await a.idle();
    assert.equal(a.get(accepted.json().id).status, "SUCCEEDED");
    assert.equal(
      f.platform.repositories.getRun(other)?.executionRevision,
      sibling.executionRevision
    );
    const removeWhole = a.submit(
      f.submitted.id,
      {
        ...body,
        kind: "REMOVE",
        expectedRevision: a.eligibility(f.submitted.id).executionRevision
      },
      "remove-parent-after-individual"
    );
    await a.idle();
    assert.equal(a.get(removeWhole.id).status, "SUCCEEDED");
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${target}/actions`,
      headers: { "idempotency-key": "pending-one" },
      payload: body
    });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().experimentId, undefined);
    assert.equal(replay.json().runId, undefined);
  } finally {
    gate.resolve();
    await f.platform.experimentActions.idle();
    await app.close();
    f.close();
  }
});

test("individual scope rejects active sibling execution and cannot remove a run", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const a = f.platform.experimentActions as any,
      target = f.runIds[0];
    const other = f.platform.repositories.getRun(f.runIds[1])!;
    other.state = "MEASURING";
    f.platform.repositories.saveRun(other);
    const rev = other.executionRevision;
    assert.equal(a.runEligibility(target).rerun.allowed, false);
    assert.throws(
      () =>
        a.submitRun(
          target,
          {
            contractVersion: "experiment-action.v1",
            kind: "RERUN",
            confirm: true,
            expectedRevision: rev
          },
          "active-child"
        ),
      /experiment_active/
    );
    assert.throws(
      () =>
        a.submitRun(
          target,
          {
            contractVersion: "experiment-action.v1",
            kind: "REMOVE",
            confirm: true,
            expectedRevision: rev
          },
          "remove-child"
        ),
      /request_invalid/
    );
    assert.equal(f.platform.repositories.listRuns(f.submitted.id).length, 4);
  } finally {
    f.close();
  }
});
