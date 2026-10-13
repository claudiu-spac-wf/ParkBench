import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { buildServer } from "../../apps/control-plane/src/server";
import { createPlatform } from "../../apps/control-plane/src/platform";

const apps: any[] = [];
const validMatrix = {
  runName: "test-run",
  scenario: { id: "crud-rest", version: "1.0.0" },
  dimensions: [
    { name: "-B", values: [500, 1000, 1500, 2000] },
    { name: "-B2", values: [500, 1000, 1500, 2000] }
  ],
  repetitions: 1
};

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe("control UI queue workflow", () => {
  it("previews exactly 16 cells, requires confirmation, and queues immutable runs", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-control-ui",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true, phaseScale: 0 }
    );
    platform.scenarios.register(scenario);
    platform.controlUi.syncExistingScenarios();
    const app = buildServer(platform);
    apps.push(app);
    await platform.startupRecovery;
    const missingName = await app.inject({
      method: "POST",
      url: "/api/v1/experiments/preview",
      payload: { ...validMatrix, runName: "" }
    });
    assert.equal(missingName.statusCode, 422);
    assert.match(missingName.body, /run_name_required/);
    const previewResponse: any = await app.inject({
      method: "POST",
      url: "/api/v1/experiments/preview",
      payload: validMatrix
    });
    assert.equal(previewResponse.statusCode, 200);
    const preview = JSON.parse(previewResponse.body);
    assert.equal(preview.cellCount, 16);
    assert.equal(preview.runCount, 16);
    assert.equal(preview.confirmationRequired, true);
    assert.equal(preview.cells.items.length, 16);
    const submission: any = await app.inject({
      method: "POST",
      url: "/api/v1/experiments",
      headers: { "idempotency-key": "control-ui-submit-test" },
      payload: { previewId: preview.previewId, confirm: true }
    });
    assert.equal(submission.statusCode, 202);
    const experiment = JSON.parse(submission.body);
    assert.equal(experiment.runCount, 16);
    assert.equal(experiment.runs.length, 16);
    const queue: any = await app.inject({ method: "GET", url: "/api/v1/queue" });
    assert.equal(JSON.parse(queue.body).items.length, 16);
  });

  it("requires confirmation and supports descriptive comparisons without a baseline", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-control-ui-compare",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true, phaseScale: 0 }
    );
    platform.scenarios.register(scenario);
    platform.controlUi.syncExistingScenarios();
    const app = buildServer(platform);
    apps.push(app);
    await platform.startupRecovery;
    const preview: any = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/experiments/preview",
          payload: { ...validMatrix, dimensions: [{ name: "-B", values: [500] }] }
        })
      ).body
    );
    const stale: any = await app.inject({
      method: "POST",
      url: "/api/v1/experiments",
      headers: { "idempotency-key": "control-ui-stale-test" },
      payload: { previewId: preview.previewId, confirm: false }
    });
    assert.equal(stale.statusCode, 422);
    const submit: any = await app.inject({
      method: "POST",
      url: "/api/v1/experiments",
      headers: { "idempotency-key": "control-ui-descriptive-test" },
      payload: { previewId: preview.previewId, confirm: true }
    });
    const experiment = JSON.parse(submit.body);
    const comparison: any = await app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: {
        experimentId: experiment.id,
        variantRunIds: experiment.runs.map((run: any) => run.id)
      }
    });
    assert.equal(JSON.parse(comparison.body).contractVersion, "comparison.v2");
    assert.equal(JSON.parse(comparison.body).baselineRunId, undefined);
    const exported: any = await app.inject({
      method: "GET",
      url: `/api/v1/comparisons/${experiment.id}/export`
    });
    assert.equal(exported.statusCode, 200);
    assert.match(String(exported.headers["content-type"]), /text\/csv/);
    assert.match(
      String(exported.headers["content-disposition"]),
      /attachment; filename="comparison-/
    );
    assert.match(exported.body, /run_id,run_name,role,state,measurement_validity,/);
    assert.match(exported.body, new RegExp(experiment.runs[0].id));
  });

  it("keeps temporary capacity pressure queued with the documented retry schedule", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-control-ui-retry",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true, phaseScale: 0 }
    );
    platform.scenarios.register(scenario);
    platform.controlUi.syncExistingScenarios();
    const app = buildServer(platform);
    apps.push(app);
    await platform.startupRecovery;
    const preview: any = platform.controlUi.preview({
      runName: "test-run",
      ...validMatrix,
      dimensions: [{ name: "-B", values: [500] }]
    });
    platform.controlUi.submit(
      { previewId: preview.previewId, confirm: true },
      "control-ui-retry-test"
    );
    const previous = process.env.PARKBENCH_TEMP_CAPACITY;
    process.env.PARKBENCH_TEMP_CAPACITY = "1";
    try {
      const response: any = await app.inject({
        method: "POST",
        url: "/api/v1/queue/start",
        payload: {}
      });
      assert.equal(response.statusCode, 202);
      const queue = JSON.parse(response.body);
      assert.equal(queue.queued[0].queueState, "QUEUED");
      assert.equal(queue.queued[0].retryCount, 1);
      assert.ok(queue.queued[0].nextRetryAt);
    } finally {
      if (previous === undefined) delete process.env.PARKBENCH_TEMP_CAPACITY;
      else process.env.PARKBENCH_TEMP_CAPACITY = previous;
    }
  });

  it("replays idempotent queue commands after a duplicate request", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-control-ui-idempotency",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    const app = buildServer(platform);
    apps.push(app);
    const headers = { "idempotency-key": "queue-start-replay" };
    const first: any = await app.inject({
      method: "POST",
      url: "/api/v1/queue/start",
      headers,
      payload: {}
    });
    const second: any = await app.inject({
      method: "POST",
      url: "/api/v1/queue/start",
      headers,
      payload: {}
    });
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
  });

  it("replays an idempotent cancel without changing the terminal queue result", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-control-ui-cancel-idempotency",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    platform.scenarios.register(scenario);
    platform.controlUi.syncExistingScenarios();
    const app = buildServer(platform);
    apps.push(app);
    await platform.startupRecovery;
    const preview = platform.controlUi.preview({
      runName: "test-run",
      ...validMatrix,
      dimensions: [{ name: "-B", values: [500] }]
    });
    const experiment = platform.controlUi.submit({
      previewId: preview.previewId,
      confirm: true
    });
    const runId = experiment.runs[0].id;
    const headers = { "idempotency-key": "queue-cancel-replay" };
    const first: any = await app.inject({
      method: "POST",
      url: `/api/v1/queue/runs/${runId}/cancel`,
      headers,
      payload: {}
    });
    const second: any = await app.inject({
      method: "POST",
      url: `/api/v1/queue/runs/${runId}/cancel`,
      headers,
      payload: {}
    });
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
    assert.equal(JSON.parse(second.body).queueState, "CANCELLED");
    const queueAfterCancel: any = await app.inject({ method: "GET", url: "/api/v1/queue" });
    assert.equal(
      JSON.parse(queueAfterCancel.body).items.find((item: any) => item.id === runId),
      undefined
    );
    assert.equal(platform.repositories.getRun(runId)?.state, "CANCELLED");
    assert.equal(platform.repositories.getRun(runId)?.cleanupStatus, "COMPLETE");
  });

  it("replays a queue command after a control-plane restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-queue-restart-"));
    const config = {
      host: "127.0.0.1",
      port: 0,
      dbPath: path.join(root, "control.sqlite"),
      artifactRoot: path.join(root, "artifacts"),
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {}
    };
    const firstPlatform = createPlatform(config, { testMode: true });
    const firstApp = buildServer(firstPlatform);
    apps.push(firstApp);
    await firstPlatform.startupRecovery;
    const key = { "idempotency-key": "queue-restart-replay" };
    const first: any = await firstApp.inject({
      method: "POST",
      url: "/api/v1/queue/start",
      headers: key,
      payload: {}
    });
    assert.equal(first.statusCode, 202);
    await firstApp.close();
    apps.splice(apps.indexOf(firstApp), 1);

    const secondPlatform = createPlatform(config, { testMode: true });
    const secondApp = buildServer(secondPlatform);
    apps.push(secondApp);
    await secondPlatform.startupRecovery;
    const replay: any = await secondApp.inject({
      method: "POST",
      url: "/api/v1/queue/start",
      headers: key,
      payload: {}
    });
    assert.equal(replay.statusCode, 202);
    assert.deepEqual(JSON.parse(replay.body), JSON.parse(first.body));
    await secondApp.close();
    apps.splice(apps.indexOf(secondApp), 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("automatically retries queued work after temporary capacity recovers", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-control-ui-auto-retry",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true, phaseScale: 0 }
    );
    await platform.startupRecovery;
    platform.scenarios.register(scenario);
    platform.controlUi.syncExistingScenarios();
    const preview = platform.controlUi.preview({
      runName: "test-run",
      ...validMatrix,
      dimensions: [{ name: "-B", values: [500] }]
    });
    platform.controlUi.submit(
      { previewId: preview.previewId, confirm: true },
      "control-ui-auto-retry-test"
    );
    const previous = process.env.PARKBENCH_TEMP_CAPACITY;
    process.env.PARKBENCH_TEMP_CAPACITY = "1";
    try {
      await platform.controlUi.startQueue();
      delete process.env.PARKBENCH_TEMP_CAPACITY;
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      const state = platform.controlUi.listQueue()[0]?.queueState;
      assert.notEqual(state, "QUEUED");
    } finally {
      if (previous === undefined) delete process.env.PARKBENCH_TEMP_CAPACITY;
      else process.env.PARKBENCH_TEMP_CAPACITY = previous;
      platform.close();
    }
  });
});
