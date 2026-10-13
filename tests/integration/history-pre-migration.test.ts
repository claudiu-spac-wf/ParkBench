import { describe, it } from "node:test";
import assert from "node:assert/strict";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";

describe("history of runs recorded before feature 014", () => {
  it("lists a Sports2020-era run with its recorded inputs and no re-validation", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-history-pre-migration",
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
        runName: "legacy-run",
        scenario: { id: "crud-rest", version: "1.0.0" },
        dimensions: [{ name: "-B", values: [500] }],
        repetitions: 1
      });
      const experiment = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
      const run = platform.repositories.getRun(experiment.runs[0].id)!;
      // Evidence exactly as a pre-migration run stored it: a tarball seed and database "sports".
      const legacySeed = "/var/lib/parkbench/seeds/sports2020-seeds.tar.gz";
      run.state = "SUCCEEDED";
      run.measurementValidity = "VALID";
      run.cleanupStatus = "COMPLETE";
      (run.environmentSnapshot as any).inputs = {
        ...(run.environmentSnapshot as any).inputs,
        seed: legacySeed
      };
      (run.environmentSnapshot as any).databaseStartup = {
        contractVersion: "db-startup-parameters.v1",
        databaseName: "sports",
        startupFile: { status: "present", relativePath: "startup.pf" },
        parameters: []
      };
      platform.repositories.saveRun(run);
      const history = platform.controlUi.history({ status: "SUCCEEDED" });
      assert.equal(history.length, 1);
      // The stored snapshot keeps the pre-migration inputs exactly as recorded.
      const stored = platform.repositories.getRun(run.id)!;
      assert.equal((stored.environmentSnapshot as any).inputs.seed, legacySeed);
      assert.equal((stored.environmentSnapshot as any).databaseStartup.databaseName, "sports");
      assert.equal(stored.state, "SUCCEEDED");
    } finally {
      platform.close();
    }
  });
});
