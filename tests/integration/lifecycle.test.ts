import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
describe("run lifecycle", () => {
  it("exports raw time series before cleanup and continues incomplete cells", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-"));
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: root,
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    platform.scenarios.register(scenario as any);
    const experiment: any = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "comparative",
        baselineVariantId: "baseline",
        repetitions: 1,
        variants: [
          { id: "baseline", name: "Baseline", parameters: {} },
          { id: "variant", name: "Variant", parameters: {} }
        ],
        inputs: {
          databaseImage:
            "db:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          pasImage:
            "pas:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      },
      scenario as any
    );
    const first = platform.repositories.getRun(experiment.runIds[0])!;
    const final = await platform.coordinator.executeRun(first, { missingRequiredObserver: true });
    assert.equal(final.state, "INCOMPLETE");
    assert.equal(
      platform.repositories
        .listArtifacts(final.id)
        .some((artifact) => artifact.kind === "raw_prometheus_timeseries"),
      false
    );
    assert.equal(platform.repositories.listEvents(final.id).at(-1)?.toState, "INCOMPLETE");
    platform.close();
  });
});
