import { describe, it } from "node:test";
import assert from "node:assert/strict";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";

describe("terminal history export ordering", () => {
  it("exposes the terminal run after its evidence status is stored", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-terminal-history",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    try {
      await platform.startupRecovery;
      platform.scenarios.register(scenario);
      platform.controlUi.syncExistingScenarios();
      const preview = platform.controlUi.preview({
      runName: "test-run",
        scenario: { id: "crud-rest", version: "1.0.0" },
        dimensions: [{ name: "-B", values: [500] }],
        repetitions: 1
      });
      const experiment = platform.controlUi.submit(
        { previewId: preview.previewId, confirm: true },
        "terminal-history-idempotency"
      );
      const run = platform.repositories.getRun(experiment.runs[0].id)!;
      run.state = "FAILED";
      run.failureKind = "infrastructure";
      run.cleanupStatus = "COMPLETE";
      platform.repositories.saveRun(run);
      const record = platform.controlUi.history({ runId: run.id })[0] as any;
      assert.equal(record.status, "FAILED");
      assert.equal(record.evidence.cleanupStatus, "COMPLETE");
    } finally {
      platform.close();
    }
  });
});
