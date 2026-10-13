import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createTemporaryPathFixture } from "../helpers/environment-fixture";
import { createTargetDiscovery } from "../../apps/control-plane/src/platform";

describe("run target discovery files", () => {
  it("keeps a standalone smoke file isolated while sharing Prometheus's mounted target directory", () => {
    const fixture = createTemporaryPathFixture("parkbench-target-discovery-");
    const targetRoot = fixture.resolve("prometheus targets");
    const config = {
      artifactRoot: fixture.resolve("artifacts"),
      prometheusTargetDir: targetRoot
    } as any;

    try {
      const platform = createTargetDiscovery(config, false);
      const smoke = createTargetDiscovery(config, false, "standalone-smoke-test.json");
      smoke.add("run-smoke", []);

      assert.equal(platform.filePath, path.join(targetRoot, "active-runs.json"));
      assert.equal(smoke.filePath, path.join(targetRoot, "standalone-smoke-test.json"));
      assert.equal(fs.existsSync(platform.filePath), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(smoke.filePath, "utf8")), []);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects target discovery filenames that can escape the configured directory", () => {
    const fixture = createTemporaryPathFixture("parkbench-target-discovery-");
    try {
      assert.throws(
        () =>
          createTargetDiscovery(
            { artifactRoot: fixture.resolve("artifacts") } as any,
            false,
            "../outside.json"
          ),
        /target_discovery_filename_invalid/
      );
    } finally {
      fixture.cleanup();
    }
  });
});
