import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import manifest from "../fixtures/catalog-discovery/fixture-manifest.json";
import scenario from "../../examples/scenarios/crud-rest.json";
import { DockerDiscoveryProvider } from "../../apps/control-plane/src/catalog/docker-discovery";
import { ManagedRootFileDiscovery } from "../../apps/control-plane/src/catalog/file-discovery";
import { loadConfig } from "../../packages/contracts/src/config";

describe("catalog discovery providers", () => {
  it("loads explicit roots while preserving the OpenEdge workload-root compatibility mapping", () => {
    const config = loadConfig({
      PARKBENCH_DISCOVERY_SCENARIOS_ROOT: "fixture/scenarios",
      PARKBENCH_OPENEDGE_WORKLOAD_ROOT: "fixture/workloads"
    });
    assert.match(config.discoveryRoots!.scenarios, /fixture[\\/]scenarios$/);
    assert.match(config.discoveryRoots!.workloads, /fixture[\\/]workloads$/);
  });

  it("classifies at least twenty deterministic Docker image records without exposing secrets", async () => {
    const images = manifest.dockerImages.map((image) => ({
      repository: image.repository,
      tag: image.tag,
      labels: {
        "com.parkbench.role": image.role,
        "com.parkbench.secret": "must-not-be-copied"
      }
    }));
    const provider = new DockerDiscoveryProvider({
      async listLocalImages() {
        return images;
      }
    });
    const result = await provider.discover("2026-01-01T00:00:00.000Z");
    assert.equal(result.itemCount, manifest.dockerImageCount);
    assert.equal(result.state, "READY");
    assert.ok(result.items.every((item) => item.readiness === "READY"));
    assert.ok(result.items.every((item) => !JSON.stringify(item).includes("must-not-be-copied")));
  });

  it("keeps an unknown image visible but not selectable", async () => {
    const provider = new DockerDiscoveryProvider({
      async listLocalImages() {
        return [
          {
            repository: "parkbench/unclassified",
            tag: "stable"
          }
        ];
      }
    });
    const result = await provider.discover("2026-01-01T00:00:00.000Z");
    assert.equal(result.items[0].kind, "docker_image");
    assert.equal(result.items[0].classificationState, "UNCLASSIFIED");
    assert.equal(result.items[0].readiness, "NOT_READY");
    assert.deepEqual(result.items[0].blockReasons, ["role_unrecognized"]);
  });

  it("selects a recognized available tag-only image without a missing-digest block", async () => {
    const provider = new DockerDiscoveryProvider({
      async listLocalImages() {
        return [
          {
            id: "sha256:local-image-id",
            repository: "parkbench/database",
            tag: "fixture",
            labels: { "com.parkbench.role": "database" }
          }
        ];
      }
    });
    const result = await provider.discover("2026-01-01T00:00:00.000Z");
    assert.equal(result.state, "READY");
    assert.equal(result.items[0].readiness, "READY");
    assert.deepEqual(result.items[0].blockReasons, []);
    assert.equal(result.items[0].provenance.reference, "parkbench/database:fixture");
    assert.equal(result.items[0].provenance.reference, "parkbench/database:fixture");
  });

  it("ignores unrelated Docker repositories before discovery", async () => {
    const inspected: string[] = [];
    const provider = new DockerDiscoveryProvider({
      async listLocalImages() {
        return [
          {
            repository: "parkbench/database",
            tag: "fixture",
            digest: `sha256:${"a".repeat(64)}`,
            labels: { "com.parkbench.role": "database" }
          },
          {
            repository: "postgres",
            tag: "18",
            digest: `sha256:${"c".repeat(64)}`
          },
          {
            repository: "docker.io/library/node",
            tag: "24",
            digest: `sha256:${"d".repeat(64)}`
          }
        ];
      },
      async inspectImageDetails(image) {
        inspected.push(image);
        return {};
      }
    });

    const result = await provider.discover("2026-01-01T00:00:00.000Z");
    assert.equal(result.itemCount, 1);
    assert.equal(result.items[0]?.name, "parkbench/database:fixture");
    assert.deepEqual(inspected, ["parkbench/database:fixture"]);
  });

  it("scans fifty managed files, rejects malformed scenarios, and returns stable input identities", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-discovery-"));
    try {
      const roots = Object.fromEntries(
        Object.values(manifest.fileRoots).map((name) => [name, path.join(root, name)])
      ) as Record<string, string>;
      for (const [category, categoryRoot] of Object.entries(roots)) {
        fs.mkdirSync(categoryRoot, { recursive: true });
        for (
          let index = 1;
          index <= (category === "scenarios" ? 10 : category === "configs" ? 9 : 8);
          index++
        ) {
          const extension = category === "scenarios" && index <= 2 ? ".json" :
            category === "workloads" && index <= 4 ? ".p" :
            category === "archives" && index <= 2 ? ".zip" : ".dat";
          const filename = `fixture-${category}-${String(index).padStart(2, "0")}${extension}`;
          const value =
            category === "scenarios" && index === 1
              ? JSON.stringify(scenario)
              : category === "configs" && index >= 8
                ? "configs:duplicate immutable content"
                : `${category}:${index}:deterministic fixture`;
          fs.writeFileSync(path.join(categoryRoot, filename), value);
        }
      }
      const discovery = new ManagedRootFileDiscovery(roots as any);
      const results = discovery.discoverAll("2026-01-01T00:00:00.000Z");
      assert.equal(
        results.reduce((total, result) => total + result.itemCount, 0),
        16,
        "seeds are database folders, so loose files under the seeds root are not assets"
      );
      assert.equal(results.find((result) => result.rootKey === "seeds")!.itemCount, 0);
      const scenarios = results.find((result) => result.rootKey === "scenarios")!;
      assert.equal(scenarios.state, "DEGRADED");
      assert.ok(scenarios.items.some((item) => item.readiness === "READY"));
      assert.ok(scenarios.items.some((item) => item.classificationState === "INVALID"));
      assert.ok(
        results
          .flatMap((result) => result.items)
          .every((item) => item.sourceRef.startsWith("input:"))
      );
      assert.ok(
        results.flatMap((result) => result.items).every((item) => !("content" in item.provenance))
      );

      const outside = path.join(root, "outside-secret.txt");
      fs.writeFileSync(outside, "private content");
      const escapedRoot = path.join(root, "escaped");
      fs.mkdirSync(escapedRoot);
      fs.symlinkSync(outside, path.join(escapedRoot, "secret.txt"));
      const escaped = new ManagedRootFileDiscovery({ configs: escapedRoot }).discoverRoot(
        "configs"
      );
      assert.equal(escaped.itemCount, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers only .p files from the managed workload root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-workload-discovery-"));
    const workloads = path.join(root, "workloads");
    fs.mkdirSync(path.join(workloads, "nested"), { recursive: true });
    fs.writeFileSync(path.join(workloads, "crud_cycle.p"), "procedure source");
    fs.writeFileSync(path.join(workloads, "readme.txt"), "documentation");
    fs.writeFileSync(path.join(workloads, "archive.zip"), "archive bytes");
    fs.writeFileSync(path.join(workloads, "nested", "helper.p"), "helper source");
    try {
      const result = new ManagedRootFileDiscovery({ workloads }).discoverRoot("workloads");
      assert.deepEqual(
        result.items.map((item) => item.name).sort(),
        ["crud_cycle.p", "helper.p"]
      );
      assert.ok(result.items.every((item) => item.readiness === "READY"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
