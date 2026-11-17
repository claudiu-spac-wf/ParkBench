import assert from "node:assert/strict";
import test from "node:test";
import { actionFixture } from "../fixtures/experiment-actions";
import { buildServer } from "../../apps/control-plane/src/server";
test("saved comparison and all contexts remain unavailable when public run IDs are reused", async () => {
  const f = await actionFixture();
  const app = buildServer(f.platform);
  try {
    await app.ready();
    f.terminal();
    const comparison = f.platform.controlUi.createComparison({
      baselineRunId: f.runIds[0],
      variantRunIds: [f.runIds[1]]
    });
    const a = (f.platform as any).experimentActions;
    const started = a.submit(
      f.submitted.id,
      {
        contractVersion: "experiment-action.v1",
        kind: "RERUN",
        confirm: true,
        expectedRevision: a.eligibility(f.submitted.id).executionRevision
      },
      "comparison"
    );
    await a.idle();
    assert.equal(a.get(started.id).status, "SUCCEEDED");
    for (const url of [
      `/api/v1/comparisons/${comparison.id}`,
      `/api/v1/comparisons/${comparison.id}/selection`,
      `/api/v1/comparisons/${comparison.id}/runs/${f.runIds[0]}/tables`,
      `/api/v1/comparisons/${comparison.id}/export`,
      `/api/v1/dashboards/context/${comparison.dashboardContextId}`
    ]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 410, url);
      assert.match(response.body, /unavailable_experiment_rerun/);
    }
    const metric = await app.inject({
      method: "POST",
      url: `/api/v1/comparisons/${comparison.id}/metric-values`,
      payload: {}
    });
    assert.equal(metric.statusCode, 410);
    f.terminal();
    const fresh = f.platform.controlUi.createComparison({ variantRunIds: f.runIds });
    assert.notEqual(fresh.id, comparison.id);
    assert.throws(
      () => f.platform.controlUi.getComparison(comparison.id),
      /unavailable_experiment_rerun/
    );
  } finally {
    await app.close();
  }
});

test("cross-experiment membership invalidates both roles, old cursors and single-run contexts while preserving an unrelated comparison", async () => {
  const f = await actionFixture(),
    app = buildServer(f.platform);
  try {
    await app.ready();
    f.terminal();
    const sentinel = f.additional(),
      other = sentinel.runs[0].id;
    const comparisons = [
        f.platform.controlUi.createComparison({
          baselineRunId: f.runIds[0],
          variantRunIds: [other]
        }),
        f.platform.controlUi.createComparison({ baselineRunId: other, variantRunIds: f.runIds })
      ],
      unrelated = f.platform.controlUi.createComparison({ variantRunIds: [other] });
    const cursor = f.platform.controlUi.getComparisonSelectionPage(comparisons[1].id, { limit: 1 })
      .selectionPage.nextCursor;
    const context = f.platform.controlUi.createDashboard({
      experimentId: f.submitted.id,
      runIds: [f.runIds[0]]
    });
    const a = f.platform.experimentActions,
      action = a.submit(
        f.submitted.id,
        {
          contractVersion: "experiment-action.v1",
          kind: "RERUN",
          confirm: true,
          expectedRevision: a.repository.currentRevision(f.submitted.id)
        },
        "cross-members"
      );
    await a.idle();
    assert.equal(a.get(action.id).status, "SUCCEEDED");
    for (const c of comparisons) {
      assert.equal(c.experimentId, undefined);
      assert.throws(
        () => f.platform.controlUi.comparisonPending(c.id),
        /unavailable_experiment_rerun/
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/comparisons/${c.id}/selection?cursor=${cursor}`
          })
        ).statusCode,
        410
      );
    }
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/v1/dashboards/context/${context.id}` }))
        .statusCode,
      410
    );
    assert.equal(f.platform.controlUi.getComparison(unrelated.id).id, unrelated.id);
  } finally {
    await app.close();
    f.close();
  }
});

test("quiescence terminates an already-open artifact stream before old data can finish downloading", async () => {
  const fs = await import("node:fs"),
    path = await import("node:path");
  const f = await actionFixture(),
    app = buildServer(f.platform);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    f.terminal();
    const relative = f.runIds[0] + "/large.log",
      file = path.join(f.platform.storage.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, 64 * 1024 * 1024);
    f.platform.repositories.saveArtifact({
      id: "old-large-log",
      runId: f.runIds[0],
      kind: "log",
      path: relative,
      sizeBytes: 64 * 1024 * 1024,
      format: "text",
      sourceMetadata: {},
      createdAt: new Date().toISOString(),
      retained: true
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = app.server.address().port,
      response = await fetch(
        `http://127.0.0.1:${port}/api/v1/runs/${f.runIds[0]}/artifacts/old-large-log`,
        { signal: AbortSignal.timeout(10000) }
      );
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    let bytes = (await reader.read()).value!.length;
    assert.ok((f.platform.experimentActions as any).readers.size > 0);
    const a = f.platform.experimentActions,
      started = Date.now(),
      action = a.submit(
        f.submitted.id,
        {
          contractVersion: "experiment-action.v1",
          kind: "RERUN",
          confirm: true,
          expectedRevision: a.repository.currentRevision(f.submitted.id)
        },
        "open-stream"
      );
    await a.idle();
    assert.equal(a.get(action.id).status, "SUCCEEDED");
    let rejected = false;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
      }
    } catch {
      rejected = true;
    }
    assert.ok(rejected);
    assert.ok(bytes < 64 * 1024 * 1024);
    assert.ok(Date.now() - started < 5000);
    assert.equal(fs.existsSync(file), false);
  } finally {
    await reader?.cancel().catch(() => undefined);
    await app.close();
    f.close();
  }
});
