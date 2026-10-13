import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { runExtensionScenario } from "../../apps/control-plane/src/scenarios/extension-runner";
import { observerLabels } from "../../packages/observers/src";
describe("extension lifecycle", () => {
  it("uses the existing lifecycle contract", () => {
    assert.equal(runExtensionScenario(scenario as any).lifecycle, "unchanged");
  });

  it("runs a registered versioned observer through the unchanged lifecycle", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-extension-"));
    let samples = 0;
    const extensionKind = "custom-runtime_v1";
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
      {
        testMode: true,
        observerExtensions: [
          {
            kind: extensionKind,
            factory: (declaration) => ({
              id: declaration.id,
              kind: declaration.kind,
              async ready() {
                return true;
              },
              async sample(context) {
                samples++;
                return [
                  {
                    metricName: "parkbench_custom_runtime_value",
                    labels: observerLabels(context, "observer", declaration.id),
                    timestamp: Date.now() / 1000,
                    value: 1,
                    source: "custom-extension"
                  }
                ];
              }
            })
          }
        ],
        phaseScale: 0
      }
    );
    const extensionScenario = {
      ...scenario,
      observers: [
        ...scenario.observers,
        {
          id: "custom-runtime",
          kind: extensionKind,
          required: true,
          samplingIntervalSeconds: 1
        }
      ]
    } as any;
    await platform.startupRecovery;
    platform.scenarios.register(extensionScenario);
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: extensionScenario.id, version: extensionScenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "extension", name: "Extension", parameters: {} }],
        inputs: {
          databaseImage:
            "db:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          pasImage:
            "pas:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      },
      extensionScenario
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(run.state, "INCOMPLETE");
    assert.ok(samples > 0);
    assert.ok(
      platform.observerMetrics
        .samples()
        .some((sample) => sample.metricName === "parkbench_observer_health")
    );
    assert.ok(run.observerHealth?.observers?.["custom-runtime"]);
    platform.close();
  });
});
