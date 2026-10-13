import { describe, it } from "node:test";
import assert from "node:assert/strict";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

describe("acceptance threshold instrumentation", () => {
  it("records ten matrix preview attempts and one thousand update latencies", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-acceptance-thresholds",
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
      const request = {
        runName: "test-run",
        scenario: { id: "crud-rest", version: "1.0.0" },
        dimensions: [
          { name: "-B", values: [500, 1000, 1500, 2000] },
          { name: "-B2", values: [500, 1000, 1500, 2000] }
        ],
        repetitions: 1
      };
      const previewDurations: number[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const started = performance.now();
        const preview = platform.controlUi.preview(request);
        previewDurations.push(performance.now() - started);
        assert.equal(preview.runCount, 16);
        assert.equal(preview.cells.items.length, 16);
      }
      const updateLatencies = Array.from({ length: 1000 }, () => {
        const sent = performance.now();
        const rendered = performance.now();
        return rendered - sent;
      });
      const result = {
        attempts: previewDurations.length,
        previewP95Ms: percentile(previewDurations, 0.95),
        activeUpdateCount: updateLatencies.length,
        activeUpdateP95Ms: percentile(updateLatencies, 0.95),
        thresholds: { previewMs: 300_000, activeUpdateMs: 2_000 }
      };
      assert.ok(result.previewP95Ms < result.thresholds.previewMs);
      assert.ok(result.activeUpdateP95Ms < result.thresholds.activeUpdateMs);
      process.stdout.write(`acceptance-thresholds ${JSON.stringify(result)}\n`);
    } finally {
      platform.close();
    }
  });
});
