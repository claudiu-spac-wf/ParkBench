import scenario from "../../../examples/scenarios/crud-rest.json";
import { buildServer } from "../../../apps/control-plane/src/server";
import { createPlatform } from "../../../apps/control-plane/src/platform";
import { DiscoveryProviders } from "../../../apps/control-plane/src/catalog/discovery-service";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export async function createControlUiFixture(
  options: { discoveryProviders?: DiscoveryProviders; discoveryRoots?: Record<string, string>; databaseCapabilities?: { version?: string; features?: string[] } } = {}
) {
  const fixtureRoot = options.discoveryRoots?.scenarios
    ? undefined
    : fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-ui-scenarios-"));
  if (fixtureRoot)
    fs.writeFileSync(path.join(fixtureRoot, "crud-rest.json"), JSON.stringify(scenario));
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: ".parkbench/test-control-ui-fixture",
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      discoveryRoots: {
        scenarios: fixtureRoot ?? path.resolve("examples/scenarios"),
        workloads: path.resolve("openedge/workloads/Workloads"),
        observers: path.resolve(".parkbench/observers"),
        seeds: path.resolve(".parkbench/seeds"),
        archives: path.resolve(".parkbench/archives"),
        ...options.discoveryRoots
      },
      openedge: {version:options.databaseCapabilities?.version,databaseFeatures:options.databaseCapabilities?.features}
    },
    { testMode: true, phaseScale: 0, discoveryProviders: options.discoveryProviders }
  );
  const app = buildServer(platform);
  await platform.startupRecovery;
  return {
    platform,
    app,
    async close() {
      await app.close();
      if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  };
}
