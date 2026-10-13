import { createPlatform } from "../../apps/control-plane/src/platform";
import scenario from "../../examples/scenarios/crud-rest.json";
export function runControlFixture(config: { inputRoot?: string } = {}) {
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: ".parkbench/test-run-controls",
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: { version: "12.8.11", databaseFeatures: ["enterprise"] }
    },
    { testMode: true, ...config }
  );
  const document: any = structuredClone(scenario);
  document.id = "run-controls-fixture";
  document.parameterDefinitions = [
    {
      id: "only-B",
      canonicalName: "-B",
      type: "integer",
      minimum: 10,
      maximum: 5000,
      description: "Primary buffers",
      source: "scenario",
      matrixAllowed: true,
      secret: false,
      definitionVersion: "1"
    }
  ];
  platform.scenarios.register(document);
  return { platform, document };
}
