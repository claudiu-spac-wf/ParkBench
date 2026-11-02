import assert from "node:assert/strict";
import test from "node:test";
import { ownershipLabels } from "../../packages/compose-runner/src/ownership";
test("partial provisioning cleanup includes durable intents without inventing resource creation timestamps", () => {
  let reconcile: any;
  try {
    reconcile =
      require("../../apps/control-plane/src/database-setup/evidence").reconcileSetupResources;
  } catch {
    reconcile = (_run: any, actual: any) => actual;
  }
  const labels = ownershipLabels("r", "e", "run");
  const run: any = {
    id: "r",
    environmentSnapshot: {
      databaseSetupResourceIntents: [
        { type: "volume", name: "owned-volume", labels, registeredAt: "2026-10-28T10:00:00Z" }
      ]
    }
  };
  const resources = reconcile(run, []);
  assert.equal(resources.length, 1);
  assert.equal(resources[0].resourceId, "owned-volume");
  assert.equal(resources[0].createdAt, undefined);
  const actual = {
    resourceType: "volume",
    resourceId: "owned-volume",
    labels,
    createdAt: "2026-10-28T10:01:00Z"
  };
  assert.deepEqual(reconcile(run, [actual]), [actual]);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src/orchestrator";
import { compileDatabaseSetup } from "../../apps/control-plane/src/database-setup/compile-plan";
import { generateRunCompose } from "../../packages/compose-runner/src/run-compose";
import scenario from "../../examples/scenarios/crud-rest.json";
test("restart interrupts setup, gathers evidence and cleans frozen resources without provisioning or release", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-setup-recovery-"));
  const config: any = {
    host: "127.0.0.1",
    port: 0,
    dbPath: path.join(root, "state.sqlite"),
    artifactRoot: path.join(root, "artifacts"),
    prometheusUrl: "http://localhost:9090",
    prometheusRetention: "7d",
    openedge: {}
  };
  let platform = createPlatform(config, { testMode: true, phaseScale: 0 });
  let runId = "",
    control = "";
  try {
    await platform.startupRecovery;
    const setup: any = {
      contractVersion: "database-setup.v1",
      steps: [{ id: "s", definitionId: "idxbuild", optionSets: [{ id: "o", scope: "all" }] }]
    };
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "v", name: "V", parameters: {}, databaseSetup: setup }],
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
    const run = platform.repositories.getRun(experiment.runIds[0])!;
    runId = run.id;
    const plan = compileDatabaseSetup({
      runId,
      attemptId: "interrupted",
      setup,
      runtimeDirectory: path.join(config.artifactRoot, runId, "runtime"),
      databaseName: "testdb",
      image: "fixture/db:1"
    });
    control = plan.manifest.paths.control;
    const bundle = generateRunCompose(
      runId,
      experiment.id,
      scenario as any,
      { db: "fixture/db:1", pas: "fixture/pas:1" },
      {
        databaseSetup: plan.manifest,
        seed: "input:seed",
        loadgenImage: "fixture/load:1",
        observerImage: "fixture/observer:1"
      }
    );
    run.state = "PROVISIONING";
    run.startedAt = new Date().toISOString();
    run.environmentSnapshot = {
      ...run.environmentSnapshot,
      databaseSetupManifest: plan.manifest,
      databaseSetupBundle: bundle,
      databaseSetupResourceIntents: bundle.resources.map((r) => ({
        ...r,
        registeredAt: new Date().toISOString()
      }))
    };
    platform.repositories.saveRun(run);
    platform.close();
    const calls: string[] = [];
    class RecoveryRunner extends FakeRunOrchestrator {
      async provision(_bundle: any): Promise<never> {
        throw new Error("must_not_provision");
      }
      async waitForDatabaseSetup(): Promise<never> {
        throw new Error("must_not_resume");
      }
      async startRemainingServices() {
        throw new Error("must_not_release");
      }
      async cleanup(bundle: any, resources: any) {
        calls.push("cleanup");
        return super.cleanup(bundle, resources);
      }
    }
    platform = createPlatform(config, {
      testMode: true,
      orchestrator: new RecoveryRunner(),
      phaseScale: 0
    });
    await platform.startupRecovery;
    const recovered = platform.repositories.getRun(runId)!;
    assert.equal(recovered.state, "INTERRUPTED");
    assert(calls.includes("cleanup"));
    assert.equal(recovered.cleanupStatus, "COMPLETE");
    assert(!fs.existsSync(path.join(control, "normal-start-release")));
    assert(fs.existsSync(path.join(control, "cancel")));
    assert.equal(
      (recovered.environmentSnapshot?.databaseSetupEvidence as any).state,
      "INTERRUPTED"
    );
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
