import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src/orchestrator";
import scenario from "../../examples/scenarios/crud-rest.json";
for (const mode of ["normal", "partial-provision", "quiescence-failed"]) {
  test(`run lifecycle ${mode} freezes diagnostics before provision and gathers before cleanup`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-diagnostic-lifecycle-")),
      trace: string[] = [];
    class Runner extends FakeRunOrchestrator {
      async provision(bundle: any) {
        const run = platform.repositories.getRun(bundle.resources[0].labels["parkbench.run_id"]);
        assert.equal(
          run.environmentSnapshot.measurementDiagnosticsEvidence.recordingState,
          "RECORDING"
        );
        assert.ok(run.environmentSnapshot.measurementDiagnosticsMount.directory);
        trace.push("provision");
        if (mode === "partial-provision") throw new Error("fixture_creation_failed");
        return super.provision(bundle);
      }
      async inspectMeasurementTopology() {
        return [
          {
            group: "database" as const,
            service: "database",
            memberId: "a".repeat(64),
            imageId: "sha256:fixture"
          }
        ];
      }
      async quiesceMeasurementProducers() {
        trace.push("quiesce");
        if (mode === "quiescence-failed") throw new Error("fixture_quiescence_unknown");
      }
      async cleanup(bundle: any, resources: any) {
        trace.push("cleanup");
        const run = platform.repositories.getRun(bundle.resources[0].labels["parkbench.run_id"]);
        assert.notEqual(
          run.environmentSnapshot.measurementDiagnosticsEvidence.recordingState,
          "RECORDING"
        );
        assert.ok(
          platform.repositories
            .listArtifacts(run.id)
            .some((a: any) => a.sourceMetadata?.role === "manifest")
        );
        return super.cleanup(bundle, resources);
      }
    }
    const platform: any = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: root,
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      } as any,
      { testMode: true, orchestrator: new Runner(), phaseScale: 0 }
    );
    try {
      await platform.startupRecovery;
      const experiment = platform.coordinator.createExperiment(
        {
          scenario: { id: scenario.id, version: scenario.version },
          comparisonMode: "exploratory",
          repetitions: 1,
          variants: [{ id: "v", name: "V", parameters: {} }],
          inputs: {
            databaseImage: "fixture/db:1",
            pasImage: "fixture/pas:1",
            seed: "input:seed",
            applicationArchive: "input:archive",
            databaseName: "testdb"
          }
        },
        scenario as any
      );
      const result = await platform.coordinator.executeRun(
        platform.repositories.getRun(experiment.runIds[0])
      );
      assert.equal(result.cleanupStatus, "COMPLETE");
      assert.ok(trace.indexOf("quiesce") < trace.indexOf("cleanup"));
      const manifest = platform.repositories
        .listArtifacts(result.id)
        .find((a: any) => a.sourceMetadata?.role === "manifest");
      assert.ok(manifest);
      assert.notEqual(result.failureKind, "measurement_diagnostics");
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("audit recovery without a native mount still verifies every owned native service namespace", async () => {
  const { DockerComposeOrchestrator } =
    await import("../../packages/compose-runner/src/orchestrator");
  const runner = new DockerComposeOrchestrator("/unused-owned-fixture");
  const bundle: any = {
    projectName: "owned-recovery",
    resources: [{ labels: { "parkbench.run_id": "run-owned" } }]
  };
  let foreign = false;
  (runner as any).diagnosticContainers = async (project: string) => {
    assert.equal(project, "owned-recovery");
    return [
      {
        id: "a".repeat(64),
        service: "db-observer",
        runId: foreign ? "different-run" : "run-owned",
        state: "exited"
      }
    ];
  };
  await runner.quiesceMeasurementProducers(bundle);
  foreign = true;
  await assert.rejects(runner.quiesceMeasurementProducers(bundle), /owner_invalid/);
});
