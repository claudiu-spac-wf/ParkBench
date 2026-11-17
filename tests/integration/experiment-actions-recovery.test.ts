import assert from "node:assert/strict";
import test from "node:test";
import { actionFixture, deferred } from "../fixtures/experiment-actions";
import { ActionRepository } from "../../apps/control-plane/src/experiments/actions/repository";
import { ActionWorker } from "../../apps/control-plane/src/experiments/actions/worker";
test("partial deletion remains fenced and retry cannot create a second replacement", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const a = (f.platform as any).experimentActions;
    const admin = a.metricAdmin;
    const original = admin.delete.bind(admin);
    let failed = true;
    admin.delete = async (s: string[]) => {
      if (failed) throw Error("experiment_metrics_delete_failed");
      return original(s);
    };
    const body = {
      contractVersion: "experiment-action.v1",
      kind: "RERUN",
      confirm: true,
      expectedRevision: a.eligibility(f.submitted.id).executionRevision
    };
    const started = a.submit(f.submitted.id, body, "partial");
    await a.idle();
    assert.equal(a.get(started.id).status, "FAILED");
    assert.equal(new ActionRepository(f.platform.database).isFenced(f.submitted.id), true);
    assert.throws(
      () => f.platform.coordinator.startExperiment(f.submitted.id),
      /action_in_progress/
    );
    failed = false;
    a.retry(started.id, { contractVersion: "experiment-action.v1", confirm: true }, "retry");
    await a.idle();
    assert.equal(a.get(started.id).status, "SUCCEEDED");
    assert.equal(f.platform.repositories.listRuns(f.submitted.id).length, 4);
    assert.equal(a.submit(f.submitted.id, body, "partial").id, started.id);
  } finally {
    await (f.platform as any).experimentActions?.idle();
    f.close();
  }
});

test("retry of a validation rejection cannot fence an experiment that has since become active", async () => {
  const f = await actionFixture();
  const active = f.platform.coordinator.isExperimentActive;
  try {
    f.terminal();
    const actions = f.platform.experimentActions;
    actions.metricAdmin.preflight = async () => {
      throw Error("experiment_metrics_deletion_unavailable");
    };
    const accepted = actions.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: actions.eligibility(f.submitted.id).executionRevision
      },
      "validation-retry-active"
    );
    await actions.idle();
    assert.equal(actions.get(accepted.id).status, "FAILED");
    assert.equal(actions.repository.isFenced(f.submitted.id), false);
    f.platform.coordinator.isExperimentActive = () => true;
    assert.throws(
      () =>
        actions.retry(
          accepted.id,
          { contractVersion: "experiment-action.v1", confirm: true },
          "retry-active"
        ),
      /experiment_active/
    );
    assert.equal(actions.repository.isFenced(f.submitted.id), false);
  } finally {
    f.platform.coordinator.isExperimentActive = active;
    f.close();
  }
});

test("first current-revision samples arriving during quiescence are inside the sealed deletion scope", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const actions = f.platform.experimentActions,
      admin = actions.metricAdmin as any;
    const revision = actions.eligibility(f.submitted.id).executionRevision;
    admin.quiesce = async () => {
      admin.client.samples.push({
        metricName: "late_first_sample",
        value: 1,
        timestamp: new Date().toISOString(),
        labels: { run_id: f.runIds[0], experiment_id: f.submitted.id, execution_revision: revision }
      });
    };
    const accepted = actions.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: revision
      },
      "late-first-sample"
    );
    await actions.idle();
    assert.equal(actions.get(accepted.id).status, "SUCCEEDED");
    assert.equal(admin.client.samples.length, 0);
  } finally {
    f.close();
  }
});

test("replay cleanup finds nested identity keys and artifact filenames without erasing prefix neighbours", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const repo = f.platform.repositories,
      actions = f.platform.experimentActions,
      id = f.runIds[0];
    repo.saveIdempotency("nested-map", "nested-map", 200, { data: { [id]: { status: "old" } } });
    repo.saveIdempotency("artifact-path", "artifact-path", 200, { file: `/results/${id}.json` });
    repo.saveIdempotency(`cancel-run:${id}-neighbour`, "independent", 200, {
      status: "independent"
    });
    const accepted = actions.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: actions.eligibility(f.submitted.id).executionRevision
      },
      "replay-boundaries"
    );
    await actions.idle();
    assert.equal(actions.get(accepted.id).status, "SUCCEEDED");
    assert.throws(() => repo.getIdempotency("nested-map", "nested-map"), /revision_stale/);
    assert.throws(() => repo.getIdempotency("artifact-path", "artifact-path"), /revision_stale/);
    assert.ok(repo.getIdempotency(`cancel-run:${id}-neighbour`, "independent"));
  } finally {
    f.close();
  }
});
test("restart recovery resumes its saved checkpoint without repeating validation or final reset", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const repo = new ActionRepository(f.platform.database);
    const a = repo.reserve(
      f.submitted.id,
      "RERUN",
      repo.currentRevision(f.submitted.id),
      "restart"
    );
    repo.stage(a.id, "DELETING_FILES", {
      metricScope: ['{run_id="old",execution_revision="old"}']
    });
    let removed = 0,
      finalized = 0;
    const hooks = {
      validate: async () => {
        throw Error("revalidated");
      },
      quiesce: async () => {},
      invalidateComparisons: async () => {},
      deleteMetrics: async () => {
        throw Error("redeleted");
      },
      deleteFiles: async () => {
        removed++;
      },
      finalize: () => {
        finalized++;
      }
    };
    const worker = new ActionWorker(repo, hooks);
    worker.recover();
    await worker.idle();
    await worker.close();
    const restarted = new ActionWorker(repo, hooks);
    restarted.recover();
    await restarted.idle();
    await restarted.close();
    assert.equal(removed, 1);
    assert.equal(finalized, 1);
  } finally {
    f.close();
  }
});

test("queue wakeup failure cannot downgrade the committed target-free completion receipt", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const repo = new ActionRepository(f.platform.database);
    const action = repo.reserve(
      f.submitted.id,
      "RERUN",
      repo.currentRevision(f.submitted.id),
      "wake-failure"
    );
    repo.stage(action.id, "RESETTING");
    let finalized = 0;
    const worker = new ActionWorker(repo, {
      validate: async () => ({}),
      quiesce: async () => {},
      invalidateComparisons: async () => {},
      deleteMetrics: async () => {},
      deleteFiles: async () => {},
      finalize: () => {
        finalized++;
      },
      afterComplete: () => {
        throw Error("queue_wakeup_failed");
      }
    });
    worker.recover();
    await worker.idle();
    worker.recover();
    await worker.idle();
    await worker.close();
    assert.equal(finalized, 1);
    assert.equal(repo.get(action.id)!.status, "SUCCEEDED");
    assert.equal(repo.get(action.id)!.experimentId, undefined);
    assert.equal(repo.isFenced(f.submitted.id), false);
    repo.stage(action.id, "DELETING_FILES", { experimentId: f.submitted.id, holdsFence: true });
    repo.save({
      ...action,
      stage: "DELETING_FILES",
      status: "PENDING",
      holdsFence: true,
      metricScope: ["old-target"],
      manifest: { runIds: f.runIds }
    });
    assert.equal(repo.get(action.id)!.status, "SUCCEEDED");
    assert.equal(repo.get(action.id)!.experimentId, undefined);
    assert.equal(repo.isFenced(f.submitted.id), false);
    assert.equal(
      (
        f.platform.database.db
          .prepare("SELECT COUNT(*) n FROM experiment_action_pages WHERE action_id=?")
          .get(action.id) as any
      ).n,
      0
    );
  } finally {
    f.close();
  }
});

test("late old collectors, artifacts and command replays cannot restore replaced evidence", async () => {
  const { executionScope } = await import("../../apps/control-plane/src/db/execution");
  const f = await actionFixture();
  try {
    f.terminal();
    const old = f.platform.repositories.getRun(f.runIds[0])!,
      a = f.platform.experimentActions,
      db = f.platform.database.db;
    f.platform.repositories.saveIdempotency("cancel-run:" + old.id, "old-command", 202, {
      nested: { run: old }
    });
    const action = a.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: old.executionRevision
      },
      "late-work"
    );
    await a.idle();
    assert.equal(a.get(action.id).status, "SUCCEEDED");
    assert.throws(
      () => f.platform.repositories.getIdempotency("cancel-run:" + old.id, "old-command"),
      /revision_stale/
    );
    executionScope.run({ runId: old.id, revision: old.executionRevision! }, () => {
      assert.throws(() => f.platform.repositories.saveRun(old), /revision_stale/);
      assert.throws(
        () => f.platform.storage.write(old.id + "/late.txt", "old data"),
        /revision_stale/
      );
      assert.throws(
        () => f.platform.repositories.claimSummaryAttempt(old.id, "semantic", 1000),
        /revision_stale/
      );
    });
    assert.equal(db.prepare("SELECT count(*) n FROM artifacts WHERE run_id=?").get(old.id).n, 0);
  } finally {
    f.close();
  }
});

test("the final transaction rolls back atomically and explicit retry never re-deletes replacement data", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const a = f.platform.experimentActions,
      db = f.platform.database.db;
    let deletes = 0;
    const admin = a.metricAdmin,
      remove = admin.delete.bind(admin);
    admin.delete = async (s) => {
      deletes++;
      await remove(s);
    };
    db.exec(
      "CREATE TRIGGER reject_reset BEFORE UPDATE OF state ON runs WHEN NEW.state='QUEUED' BEGIN SELECT RAISE(ABORT,'injected reset failure'); END;"
    );
    const revision = a.repository.currentRevision(f.submitted.id),
      action = a.submit(
        f.submitted.id,
        {
          contractVersion: "experiment-action.v1",
          kind: "RERUN",
          confirm: true,
          expectedRevision: revision
        },
        "atomic-final"
      );
    await a.idle();
    assert.equal(a.get(action.id).stage, "RESETTING");
    assert.equal(a.get(action.id).status, "FAILED");
    assert.equal(a.repository.currentRevision(f.submitted.id), revision);
    assert.equal(f.platform.repositories.getRun(f.runIds[0])?.state, "FAILED");
    const replacement = a.repository.get(action.id)!.replacementRevision;
    db.exec("DROP TRIGGER reject_reset");
    a.retry(action.id, { contractVersion: "experiment-action.v1", confirm: true }, "retry-final");
    await a.idle();
    assert.equal(a.get(action.id).status, "SUCCEEDED");
    assert.equal(a.repository.currentRevision(f.submitted.id), replacement);
    assert.equal(deletes, 1);
    assert.equal(
      db.prepare("SELECT count(*) n FROM experiment_action_pages WHERE action_id=?").get(action.id)
        .n,
      0
    );
  } finally {
    f.close();
  }
});
for (const stage of [
  "validate",
  "quiesce",
  "invalidateComparisons",
  "deleteMetrics",
  "deleteFiles"
] as const)
  test(`a process stop during ${stage} resumes the saved checkpoint with one final commit`, async () => {
    const f = await actionFixture();
    try {
      f.terminal();
      const repo = new ActionRepository(f.platform.database),
        entered = deferred(),
        gate = deferred();
      const action = repo.reserve(
        f.submitted.id,
        "RERUN",
        repo.currentRevision(f.submitted.id),
        "stop-" + stage
      );
      let finalized = 0;
      const calls: Record<string, number> = {};
      const hooks: any = {
        validate: async () => ({
          manifest: { runIds: f.runIds },
          metricScope: ['{run_id="old",execution_revision="old"}']
        }),
        quiesce: async () => {},
        invalidateComparisons: async () => {},
        deleteMetrics: async () => {},
        deleteFiles: async () => {},
        finalize: () => {
          finalized++;
        }
      };
      const original = hooks[stage];
      hooks[stage] = async (...args: any[]) => {
        const result = await original(...args);
        entered.resolve();
        await gate.promise;
        return result;
      };
      const worker = new ActionWorker(repo, hooks);
      worker.enqueue(action.id);
      await entered.promise;
      const stopping = worker.close();
      gate.resolve();
      await stopping;
      hooks[stage] = async (...args: any[]) => {
        calls[stage] = (calls[stage] ?? 0) + 1;
        return original(...args);
      };
      const restored = new ActionWorker(repo, hooks);
      restored.recover();
      await restored.idle();
      await restored.close();
      assert.equal(repo.get(action.id)?.status, "SUCCEEDED");
      assert.equal(finalized, 1);
      assert.equal(calls[stage], 1);
    } finally {
      f.close();
    }
  });

test("pending cleanup blocks saved command bodies and Grafana run queries before reading prior data", async () => {
  const { buildServer } = await import("../../apps/control-plane/src/server");
  const f = await actionFixture(),
    app = buildServer(f.platform),
    gate = deferred();
  try {
    await app.ready();
    f.terminal();
    const admin = f.platform.experimentActions.metricAdmin,
      preflight = admin.preflight.bind(admin);
    admin.preflight = async () => {
      await gate.promise;
      await preflight();
    };
    f.platform.repositories.saveIdempotency("control-ui-submit", "old-submit", 202, f.submitted);
    const a = f.platform.experimentActions;
    a.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: a.repository.currentRevision(f.submitted.id)
      },
      "reader-fence"
    );
    assert.throws(
      () => f.platform.repositories.getIdempotency("control-ui-submit", "old-submit"),
      /action_in_progress/
    );
    const query = encodeURIComponent(`sum(x{run_id="${f.runIds[0]}"})`);
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/v1/grafana/prom/api/v1/query?query=" + query }))
        .statusCode,
      409
    );
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/v1/history/runs/${f.runIds[0]}` })).statusCode,
      409
    );
    gate.resolve();
    await a.idle();
  } finally {
    gate.resolve();
    await app.close();
    f.close();
  }
});

test("a fresh platform restores a paged pending action before ordinary reconciliation and keeps comparison notices after another restart", async () => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path"),
    { createPlatform } = await import("../../apps/control-plane/src/platform");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-action-restart-")),
    file = path.join(root, "state.sqlite"),
    f = await actionFixture({}, file),
    entered = deferred(),
    gate = deferred();
  let restored: any;
  try {
    f.terminal();
    const comparison = f.platform.controlUi.createComparison({ variantRunIds: f.runIds });
    const a = f.platform.experimentActions,
      admin = a.metricAdmin;
    admin.quiesce = async () => {
      entered.resolve();
      await gate.promise;
    };
    const action = a.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: a.repository.currentRevision(f.submitted.id)
      },
      "platform-restart"
    );
    await entered.promise;
    const token = a.repository.get(action.id)!.replacementRevision;
    const close = f.platform.close();
    gate.resolve();
    await close;
    restored = createPlatform({ ...f.platform.config, dbPath: file }, { testMode: true });
    await restored.startupRecovery;
    await restored.experimentActions.idle();
    assert.equal(restored.experimentActions.get(action.id).status, "SUCCEEDED");
    assert.equal(restored.experimentActions.repository.currentRevision(f.submitted.id), token);
    assert.ok(restored.repositories.listRuns(f.submitted.id).every((r) => r.state === "QUEUED"));
    assert.throws(
      () => restored.controlUi.getComparison(comparison.id),
      /unavailable_experiment_rerun/
    );
    await restored.close();
    restored = createPlatform({ ...f.platform.config, dbPath: file }, { testMode: true });
    await restored.startupRecovery;
    assert.throws(
      () => restored.controlUi.getComparison(comparison.id),
      /unavailable_experiment_rerun/
    );
    assert.equal(restored.experimentActions.get(action.id).status, "SUCCEEDED");
  } finally {
    gate.resolve();
    await restored?.close();
    await f.platform.close();
    f.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("admission excludes awaited preflight and dispatch rechecks a durable fence at commit", async () => {
  const f = await actionFixture(),
    entered = deferred(),
    gate = deferred();
  try {
    const ui = f.platform.controlUi as any;
    ui.preflightExperimentInputs = async () => {
      entered.resolve();
      await gate.promise;
    };
    const start = ui.startQueue();
    await entered.promise;
    const a = f.platform.experimentActions,
      revision = a.repository.currentRevision(f.submitted.id);
    assert.throws(
      () =>
        a.submit(
          f.submitted.id,
          {
            contractVersion: "experiment-action.v1",
            kind: "REMOVE",
            confirm: true,
            expectedRevision: revision
          },
          "preflight-remove"
        ),
      /experiment_active/
    );
    const reservation = a.repository.reserve(
      f.submitted.id,
      "REMOVE",
      revision,
      "durable-concurrent-fence"
    );
    gate.resolve();
    await start;
    assert.equal(f.platform.coordinator.isExperimentActive(f.submitted.id), false);
    assert.ok(f.platform.repositories.listRuns(f.submitted.id).every((r) => r.state === "QUEUED"));
    ui.close();
    a.repository.fail(reservation.id, "experiment_prevalidation_rejected", true);
  } finally {
    gate.resolve();
    await f.platform.close();
    f.close();
  }
});
