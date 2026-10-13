import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import scenario from "../../examples/scenarios/crud-rest.json";

describe("comparison and history projection", () => {
  it("reports dashboard fallback availability without losing stored context", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-history",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    await platform.startupRecovery;
    const context = platform.controlUi.createDashboard({
      runIds: ["run_missing"],
      metricScope: ["workload"]
    });
    assert.equal(context.runIds[0], "run_missing");
    assert.ok(platform.controlUi.getDashboard(context.id));
    const app = buildServer(platform);
    const response: any = await app.inject({
      method: "GET",
      url: `/api/v1/dashboards/context/${context.id}`
    });
    const checked = JSON.parse(response.body);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(checked.health, {
      grafana: true,
      prometheus: true,
      labelsValid: true,
      metricsAvailability: { run_missing: "available" },
      checkedAt: checked.health.checkedAt
    });
    assert.equal(checked.availability, "available");
    assert.deepEqual(platform.controlUi.history(), []);
    await app.close();
  });

  it("keeps the selected baseline in comparison evidence and dashboard scope", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-comparison-baseline",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    await platform.startupRecovery;
    platform.scenarios.register(scenario);
    platform.controlUi.syncExistingScenarios();
    const preview = platform.controlUi.preview({
      runName: "test-run",
      scenario: { id: "crud-rest", version: "1.0.0" },
      dimensions: [{ name: "-B", values: [500, 1000] }],
      repetitions: 1
    });
    const experiment = platform.controlUi.submit({
      previewId: preview.previewId,
      confirm: true
    });
    for (const runId of experiment.runs.map((run) => run.id)) {
      const run = platform.repositories.getRun(runId)!;
      run.state = "SUCCEEDED";
      run.measurementValidity = "VALID";
      run.cleanupStatus = "COMPLETE";
      platform.repositories.saveRun(run);
    }
    const comparison = platform.controlUi.createComparison({
      experimentId: experiment.id,
      baselineRunId: experiment.runs[0].id,
      variantRunIds: experiment.runs.map((run) => run.id)
    });
    assert.equal(comparison.runs[0].role, "BASELINE");
    assert.ok(comparison.runs.some((run) => run.runId === experiment.runs[1].id));
    const dashboard = platform.controlUi.getDashboard(comparison.dashboardContextId!);
    assert.deepEqual(
      dashboard?.runIds,
      experiment.runs.map((run) => run.id)
    );
    platform.close();
  });
});
