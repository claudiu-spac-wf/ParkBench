import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import manifest from "../fixtures/catalog-discovery/fixture-manifest.json";
import { DockerDiscoveryProvider } from "../../apps/control-plane/src/catalog/docker-discovery";
import { ManagedRootFileDiscovery } from "../../apps/control-plane/src/catalog/file-discovery";

describe("control UI scale boundaries", () => {
  it("supports a large valid matrix without a fixed run-count cap", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-control-ui-scale",
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
      const values = Array.from({ length: 100 }, (_, index) => index + 10);
      const preview = platform.controlUi.preview({
      runName: "test-run",
        scenario: { id: "crud-rest", version: "1.0.0" },
        dimensions: [
          { name: "-B", values },
          { name: "-B2", values }
        ],
        repetitions: 1
      });
      assert.equal(preview.cellCount, 10_000);
      assert.equal(preview.runCount, 10_000);
      assert.equal(preview.cells.items.length, 50);
      assert.equal(preview.cells.hasMore, true);
    } finally {
      platform.close();
    }
  });

  it("discovers the twenty-image/fifty-file fixture within the five-second response boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-discovery-scale-"));
    try {
      const roots = Object.fromEntries(
        Object.values(manifest.fileRoots).map((name) => [name, path.join(root, name)])
      ) as Record<string, string>;
      for (const [category, categoryRoot] of Object.entries(roots)) {
        fs.mkdirSync(categoryRoot, { recursive: true });
        const count = category === "scenarios" ? 10 : category === "configs" ? 9 : 8;
        for (let index = 1; index <= count; index++) {
          const content =
            category === "scenarios" && index === 1
              ? JSON.stringify(scenario)
              : category === "configs" && index >= 8
                ? "duplicate"
                : `${category}-${index}`;
          fs.writeFileSync(path.join(categoryRoot, `${category}-${index}${category === "workloads" ? ".p" : ".dat"}`), content);
        }
      }
      const docker = new DockerDiscoveryProvider({
        async listLocalImages() {
          return manifest.dockerImages.map((image) => ({
            repository: image.repository,
            tag: image.tag,
            labels: { "com.parkbench.role": image.role }
          }));
        }
      });
      const files = new ManagedRootFileDiscovery(roots as any);
      const started = performance.now();
      const [dockerResult, fileResults] = await Promise.all([
        docker.discover(),
        files.discoverAll()
      ]);
      const elapsed = performance.now() - started;
      assert.equal(dockerResult.itemCount, 20);
      assert.equal(
        fileResults.reduce((total, result) => total + result.itemCount, 0),
        16
      );
      assert.ok(elapsed <= 5_000, `discovery took ${elapsed}ms`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
