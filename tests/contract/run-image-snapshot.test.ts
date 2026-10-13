import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createPlatform } from "../../apps/control-plane/src/platform";

describe("run image identity snapshots", () => {
  it("round-trips configured image references without storing resolved image hashes", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-image-snapshot-"));
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot,
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    await platform.startupRecovery;
    const run: any = {
      id: "run-image-snapshot",
      experimentId: "exp-image-snapshot",
      variantId: "baseline",
      repetition: 1,
      state: "SUCCEEDED",
      measurementValidity: "VALID",
      composeProject: "parkbench-run-image-snapshot",
      resourceNamespace: {},
      cleanupStatus: "COMPLETE",
      environmentSnapshot: { inputs: { databaseImage: "db:fixture" } },
      imageSnapshots: {
        database: {
          configuredReference: "db:fixture",
          reference: "db:fixture",
          identityStrength: "tag"
        },
        pas: {
          configuredReference: "pas:fixture@sha256:" + "a".repeat(64),
          reference: "pas:fixture@sha256:" + "a".repeat(64),
          identityStrength: "tag"
        }
      }
    };
    platform.repositories.saveRun(run);
    const restored = platform.repositories.getRun(run.id)!;
    assert.equal(restored.imageSnapshots?.database.identityStrength, "tag");
    assert.equal(
      restored.imageSnapshots?.pas.configuredReference,
      "pas:fixture@sha256:" + "a".repeat(64)
    );
    assert.equal("digest" in restored.imageSnapshots!.pas, false);
    platform.close();
  });
});
