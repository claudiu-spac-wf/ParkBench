import { describe, it } from "node:test";
import assert from "node:assert/strict";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";

describe("control UI history evidence", () => {
  it("keeps terminal classifications searchable with configuration snapshots", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-history-evidence",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    const app = buildServer(platform);
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
        "history-evidence-idempotency"
      );
      const run = platform.repositories.getRun(experiment.runs[0].id)!;
      run.state = "INCOMPLETE";
      run.measurementValidity = "INCOMPLETE";
      run.failureKind = "infrastructure";
      run.cleanupStatus = "COMPLETE";
      run.imageSnapshots = {
        database: {
          configuredReference: "openedge-db:fixture",
          reference: "openedge-db:fixture",
          identityStrength: "tag"
        },
        pas: {
          configuredReference: "openedge-pas:fixture",
          reference: "openedge-pas:fixture",
          identityStrength: "tag"
        }
      };
      platform.repositories.saveRun(run);
      platform.artifacts.write(run.id, "log", "run.log", "fixture log\n", "text");
      const history = platform.controlUi.history({ status: "INCOMPLETE", parameter: "-B" });
      assert.equal(history.length, 1);
      assert.equal((history[0] as any).evidence.cleanupStatus, "COMPLETE");
      assert.equal((history[0] as any).effectiveConfiguration["-B"], 500);
      assert.equal((history[0] as any).images.identity.database.identityStrength, "tag");
      const listResponse: any = await app.inject({
        method: "GET",
        url: "/api/v1/history/runs?status=INCOMPLETE&workload=%2Fapi%2Fcrud"
      });
      assert.equal(listResponse.statusCode, 200);
      assert.equal(JSON.parse(listResponse.body).items.length, 1);
      const detailResponse: any = await app.inject({
        method: "GET",
        url: `/api/v1/history/runs/${run.id}`
      });
      assert.equal(detailResponse.statusCode, 200);
      const detail = JSON.parse(detailResponse.body);
      assert.equal(detail.artifacts[0].kind, "log");
      assert.ok(detail.experiment.scenarioSnapshot.workload);
      assert.equal(detail.run.imageSnapshots.pas.configuredReference, "openedge-pas:fixture");

      const secondPreview = platform.controlUi.preview({
      runName: "test-run",
        scenario: { id: "crud-rest", version: "1.0.0" },
        dimensions: [{ name: "-B", values: [600, 700] }],
        repetitions: 1
      });
      const secondExperiment = platform.controlUi.submit(
        {
          previewId: secondPreview.previewId,
          confirm: true
        },
        "history-evidence-pagination"
      );
      for (const entry of secondExperiment.runs) {
        const terminal = platform.repositories.getRun(entry.id)!;
        terminal.state = "SUCCEEDED";
        terminal.measurementValidity = "VALID";
        terminal.cleanupStatus = "COMPLETE";
        platform.repositories.saveRun(terminal);
      }
      const pagedResponse: any = await app.inject({
        method: "GET",
        url: "/api/v1/history/runs?pageSize=1"
      });
      const paged = JSON.parse(pagedResponse.body);
      assert.equal(paged.items.length, 1);
      assert.equal(paged.hasMore, true);
      assert.equal(paged.nextPageToken, "1");
    } finally {
      await app.close();
    }
  });
});
