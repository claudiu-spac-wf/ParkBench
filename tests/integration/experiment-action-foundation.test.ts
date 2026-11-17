import assert from "node:assert/strict";
import test from "node:test";
import { ActionRepository } from "../../apps/control-plane/src/experiments/actions/repository";
import { actionFixture } from "../fixtures/experiment-actions";

test("one durable action fence excludes stale or competing cleanup and validation rejection changes no result", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const repo = new ActionRepository(f.platform.database);
    const revision = repo.currentRevision(f.submitted.id);
    const before = f.platform.repositories.listRuns(f.submitted.id);
    assert.throws(
      () => repo.reserve(f.submitted.id, "RERUN", "stale", "bad-key"),
      /revision_stale/
    );
    const action = repo.reserve(f.submitted.id, "RERUN", revision, "first-key");
    assert.equal(repo.isFenced(f.submitted.id), true);
    assert.equal(repo.reserve(f.submitted.id, "RERUN", revision, "first-key").id, action.id);
    assert.throws(
      () => repo.reserve(f.submitted.id, "REMOVE", revision, "second-key"),
      /in_progress/
    );
    assert.throws(
      () => f.platform.coordinator.startExperiment(f.submitted.id),
      /action_in_progress/
    );
    repo.fail(action.id, "experiment_input_unavailable", true);
    assert.equal(repo.isFenced(f.submitted.id), false);
    assert.deepEqual(f.platform.repositories.listRuns(f.submitted.id), before);
  } finally {
    f.close();
  }
});

test("old execution capabilities cannot write a replacement and all child revisions agree", async () => {
  const f = await actionFixture();
  try {
    const repo = new ActionRepository(f.platform.database);
    const before = f.platform.repositories.getRun(f.runIds[0])!;
    assert.ok(before.executionRevision);
    assert.ok(
      f.runIds.every(
        (id) => f.platform.repositories.getRun(id)!.executionRevision === before.executionRevision
      )
    );
    repo.replaceRevision(f.submitted.id, "replacement-fixture-revision");
    assert.throws(() => f.platform.repositories.saveRun(before), /execution_revision_stale/);
    assert.equal(repo.currentRevision(f.submitted.id), "replacement-fixture-revision");
  } finally {
    f.close();
  }
});

test("completed cleanup receipts retain only an opaque replay binding and expire", async () => {
  const f = await actionFixture();
  try {
    f.terminal();
    const repo = new ActionRepository(f.platform.database);
    const revision = repo.currentRevision(f.submitted.id);
    const action = repo.reserve(f.submitted.id, "REMOVE", revision, "remove-receipt");
    const result = repo.complete(action.id, () => {});
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.experimentId, undefined);
    assert.equal(result.capsule, undefined);
    assert.equal(
      repo.receiptFor("remove-receipt", f.submitted.id, "REMOVE", revision)?.id,
      action.id
    );
    assert.equal(repo.isFenced(f.submitted.id), false);
    f.platform.database.db
      .prepare("UPDATE experiment_actions SET expires_at=0 WHERE id=?")
      .run(action.id);
    repo.purgeReceipts();
    assert.equal(repo.get(action.id), undefined);
  } finally {
    f.close();
  }
});

test("failed cleanup checkpoints keep their fence and explicit retry reuses the immutable replacement", async () => {
  const { ActionWorker } = await import("../../apps/control-plane/src/experiments/actions/worker");
  const f = await actionFixture();
  try {
    f.terminal();
    const repo = new ActionRepository(f.platform.database);
    const a = repo.reserve(
      f.submitted.id,
      "RERUN",
      repo.currentRevision(f.submitted.id),
      "retry-checkpoints"
    );
    let fail = true,
      finalized = 0;
    const worker = new ActionWorker(repo, {
      validate: async () => ({ metricScope: ['{run_id="old",execution_revision="old"}'] }),
      quiesce: async () => {},
      invalidateComparisons: async () => {},
      deleteMetrics: async () => {
        if (fail) throw Error("experiment_metrics_delete_failed");
      },
      deleteFiles: async () => {},
      finalize: () => {
        finalized++;
      }
    });
    worker.enqueue(a.id);
    await worker.idle();
    assert.equal(repo.get(a.id)?.stage, "DELETING_METRICS");
    assert.equal(repo.get(a.id)?.status, "FAILED");
    assert.equal(repo.isFenced(f.submitted.id), true);
    assert.equal(finalized, 0);
    fail = false;
    const retry = repo.retry(a.id);
    assert.equal(retry.replacementRevision, a.replacementRevision);
    worker.enqueue(a.id);
    worker.enqueue(a.id);
    await worker.idle();
    assert.equal(finalized, 1);
    assert.equal(repo.get(a.id)?.status, "SUCCEEDED");
    await worker.close();
  } finally {
    f.close();
  }
});

test("owned cleanup rejects sibling paths and symlink escapes without changing private inputs", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { safeOwnedPath, removeOwnedFiles } =
    await import("../../apps/control-plane/src/experiments/actions/ownership-manifest");
  const f = await actionFixture();
  try {
    const privateRoot = path.join(f.root, "private");
    fs.mkdirSync(privateRoot);
    fs.writeFileSync(path.join(privateRoot, "seed"), "private");
    const owned = path.join(f.root, "owned");
    fs.mkdirSync(owned);
    fs.symlinkSync(privateRoot, path.join(owned, "escape"));
    assert.throws(() => safeOwnedPath({ root: owned, relative: "../private" }), /path_unsafe/);
    assert.throws(() => safeOwnedPath({ root: owned, relative: "escape/seed" }), /path_unsafe/);
    fs.mkdirSync(path.join(owned, "run"));
    fs.writeFileSync(path.join(owned, "run", "orphan.tmp"), "old");
    await removeOwnedFiles({
      experimentId: "owned",
      runIds: ["run"],
      paths: [{ root: owned, relative: "run" }]
    });
    assert.equal(fs.existsSync(path.join(owned, "run")), false);
    assert.equal(fs.readFileSync(path.join(privateRoot, "seed"), "utf8"), "private");
  } finally {
    f.close();
  }
});

test("quiescence releases only the inactive target host claim and preserves another owner", async () => {
  for (const own of [false, true]) {
    const f = await actionFixture();
    try {
      f.terminal();
      const repo = f.platform.hostDispatcher.repository;
      repo.claim("EXPERIMENT", own ? f.submitted.id : "unrelated-owner");
      const a = f.platform.experimentActions,
        action = a.submit(
          f.submitted.id,
          {
            contractVersion: "experiment-action.v1",
            kind: "RERUN",
            confirm: true,
            expectedRevision: a.repository.currentRevision(f.submitted.id)
          },
          "claim"
        );
      await a.idle();
      assert.equal(a.get(action.id).status, "SUCCEEDED");
      assert.equal(repo.currentClaim()?.owner_id, own ? undefined : "unrelated-owner");
    } finally {
      f.close();
    }
  }
});
