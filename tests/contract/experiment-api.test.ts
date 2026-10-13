import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../../apps/control-plane/src/server";
import { createPlatform } from "../../apps/control-plane/src/platform";
import scenario from "../../examples/scenarios/crud-rest.json";

describe("experiment API", () => {
  it("retires inline experiment creation so every new run uses a disk scenario", async () => {
    const platform = createPlatform({ host: "127.0.0.1", port: 0, dbPath: ":memory:",
      artifactRoot: ".parkbench/test-inline-experiment-retired",
      prometheusUrl: "http://localhost:9090", prometheusRetention: "7d", openedge: {} },
      { testMode: true });
    const app = buildServer(platform);
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/experiments",
        payload: { scenario, comparisonMode: "exploratory", repetitions: 1,
          variants: [{ id: "baseline", name: "Baseline", parameters: {} }], inputs: {} } });
      assert.equal(response.statusCode, 410);
      assert.match(response.body, /operation_retired/);
    } finally { await app.close(); }
  });
});
