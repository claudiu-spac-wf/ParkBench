import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPlatform, testObserverFactory } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import workScenario from "../../examples/scenarios/parkbench-bank-mix.json";
import { syntheticImageManifest } from "../helpers/openedge";
import { createSeedFixture } from "../helpers/seed";

async function withPlatform(
  seedOptions: { databaseName?: string; missingExtent?: string },
  check: (context: {
    create: () => unknown;
    orchestrator: FakeRunOrchestrator;
    seed: string;
  }) => void
) {
  fs.mkdirSync(path.resolve(".parkbench"), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(".parkbench", "directory-seed-"));
  const seed = createSeedFixture(path.join(root, "seeds"), "one_gb_lnx", {
    databaseName: seedOptions.databaseName
  });
  if (seedOptions.missingExtent) fs.rmSync(path.join(seed, seedOptions.missingExtent));
  const applicationArchive = path.join(root, "runner.zip");
  fs.writeFileSync(applicationArchive, "runner-archive-fixture");
  const manifest = syntheticImageManifest("final");
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const orchestrator = new FakeRunOrchestrator();
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: path.join(root, "artifacts"),
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: { imageManifestPath: manifestPath }
    },
    {
      testMode: true,
      orchestrator,
      phaseScale: 0,
      requiredDiskIo: false,
      observerFactory: testObserverFactory()
    }
  );
  try {
    await platform.startupRecovery;
    const create = () =>
      platform.coordinator.createExperiment(
        {
          scenario: { id: workScenario.id, version: workScenario.version },
          comparisonMode: "exploratory",
          repetitions: 1,
          variants: [{ id: "baseline", name: "Baseline", parameters: {} }],
          inputs: {
            databaseImage: manifest.db.reference,
            pasImage: manifest.pasoe.reference,
            seed,
            seedName: "one_gb_lnx",
            databaseName: seedOptions.databaseName ?? "parkbench",
            applicationArchive
          }
        } as any,
        workScenario as any
      );
    check({ create, orchestrator, seed });
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("directory seed submission", () => {
  it("accepts a ParkBench seed database folder and records its identity", async () => {
    await withPlatform({}, ({ create, seed }) => {
      const experiment = create() as any;
      assert.equal(experiment.status, "QUEUED");
      assert.equal(experiment.inputs.seed, seed);
      assert.equal(experiment.inputs.databaseName, "parkbench");
      assert.equal(experiment.inputs.seedName, "one_gb_lnx");
    });
  });

  it("fails before provisioning when the seed folder is missing an extent", async () => {
    await withPlatform({ missingExtent: "parkbench_11.d1" }, ({ create, orchestrator }) => {
      assert.throws(create, /seed_database_files_missing:parkbench_11\.d1/);
      assert.deepEqual(orchestrator.calls, []);
    });
  });

  it("fails before provisioning when the seed's database name differs from the workload's", async () => {
    await withPlatform({ databaseName: "otherdb" }, ({ create, orchestrator }) => {
      assert.throws(create, /workload_database_mismatch/);
      assert.deepEqual(orchestrator.calls, []);
    });
  });
});
