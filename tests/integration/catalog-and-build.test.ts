import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPlatform } from "../../apps/control-plane/src/platform";

describe("retired individual catalog operations", () => {
  it("rejects asset registration and per-asset build and verify commands", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-catalog",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    try {
      await platform.startupRecovery;
      assert.throws(
        () => platform.controlUi.registerAsset({ kind: "workload", name: "one.p" }),
        /operation_retired/
      );
      assert.throws(
        () => platform.controlUi.startImageOperation({ kind: "VERIFY", inputAssetIds: [] }),
        /operation_retired/
      );
      assert.throws(
        () => platform.controlUi.startImageOperation({ kind: "BUILD", inputAssetIds: [] }),
        /operation_retired/
      );
    } finally {
      platform.close();
    }
  });
});
