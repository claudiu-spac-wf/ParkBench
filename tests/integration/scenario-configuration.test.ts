import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";

describe("disk scenario configuration", () => {
  it("reads the current disk version with database parameter definitions", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-scenario",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        discoveryRoots: { scenarios: path.resolve("examples/scenarios") },
        openedge: {}
      } as any,
      { testMode: true }
    );
    try {
      await platform.startupRecovery;
      const saved = platform.controlUi.getScenario("crud-rest", "1.0.0");
      assert.equal(saved?.state, "READY");
      assert.ok(
        saved?.parameterDefinitions.some((definition) => definition.canonicalName === "-B")
      );
      for (const table of ["scenarios", "control_scenarios"])
        assert.equal(
          platform.database.db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table),
          undefined
        );
    } finally {
      platform.close();
    }
  });

  it("retires editing scenario versions through the API", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-scenario-route",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    const app = buildServer(platform);
    try {
      await platform.startupRecovery;
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scenarios/crud-rest/versions",
        payload: { scenario: { id: "crud-rest", version: "1.0.1" } }
      });
      assert.equal(response.statusCode, 410);
      assert.match(response.body, /operation_retired/);
    } finally {
      await app.close();
    }
  });
});
