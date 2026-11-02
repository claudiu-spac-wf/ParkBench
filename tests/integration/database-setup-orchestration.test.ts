import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DockerComposeOrchestrator } from "../../packages/compose-runner/src/orchestrator";

for (const capability of ["<no value>", "database-setup.v0"]) {
  test(`setup refuses incompatible image capability ${capability} before starting services`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-setup-image-"));
    try {
      const commands: string[][] = [];
      const orchestrator: any = new DockerComposeOrchestrator(root);
      orchestrator.command = async (args: string[]) => {
        commands.push(args);
        return { stdout: args.includes("image") ? capability : "", stderr: "" };
      };
      const bundle: any = {
        projectName: "fixture-incompatible-image",
        file: "services: {}\n",
        scenario: {},
        metricsNetworkName: "metrics",
        localPaths: [],
        resources: [],
        databaseSetup: { manifest: { image: "fixture/db:old" } }
      };
      await assert.rejects(
        orchestrator.provision(bundle),
        /database_setup_unavailable:image_capability/
      );
      assert(commands.some((args) => args.includes("fixture/db:old")));
      assert(!commands.some((args) => args.includes("up")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("setup provision starts only the DB and waits without an ordinary readiness deadline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-setup-orchestration-"));
  try {
    const commands: string[][] = [];
    const orchestrator: any = new DockerComposeOrchestrator(root);
    orchestrator.command = async (args: string[]) => {
      commands.push(args);
      return {
        stdout: args.includes("image")
          ? "database-setup.v1"
          : args.includes("port")
            ? "127.0.0.1:19100\n"
            : "",
        stderr: ""
      };
    };
    const bundle: any = {
      projectName: "fixture-run",
      file: "services: {}\n",
      scenario: {},
      metricsNetworkName: "metrics",
      localPaths: [],
      resources: ["database", "pas-1", "db-observer", "loadgen"].map((name) => ({
        type: "container",
        name,
        labels: { "parkbench.run_id": "run" }
      })),
      databaseSetup: {
        manifest: {
          runId: "run",
          attemptId: "attempt",
          paths: { input: root, output: root, control: root }
        }
      }
    };
    await orchestrator.provision(bundle);
    const up = commands.find((a) => a.includes("up"))!;
    assert.deepEqual(up.slice(up.indexOf("up")), ["up", "-d", "database"]);
    assert(
      !commands.some((a) => a.includes("port")),
      "observers must not attach during maintenance"
    );
    assert.equal(typeof orchestrator.waitForDatabaseSetup, "function");
    assert.equal(typeof orchestrator.startRemainingServices, "function");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import { FakeRunOrchestrator } from "../../packages/compose-runner/src/orchestrator";
import { createPlatform } from "../../apps/control-plane/src/platform";
import scenario from "../../examples/scenarios/crud-rest.json";
import { readDatabaseSetupEvidence } from "../../packages/compose-runner/src/database-setup-evidence";
for (const mode of ["normal", "cancel-before-release", "partial-provision"]) {
  test(`coordinator ${mode} persists ownership and never releases cancelled or partial setup`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-setup-controller-"));
    const trace: string[] = [];
    class SetupRunner extends FakeRunOrchestrator {
      async provision(bundle: any) {
        trace.push("db-only");
        const stored = platform.repositories.getRun(bundle.databaseSetup.manifest.runId);
        assert(
          stored.environmentSnapshot.databaseSetupResourceIntents.length > 0,
          "intent must be durable before Docker creation"
        );
        if (mode === "partial-provision") throw new Error("fixture_partial_creation");
        const { manifest } = bundle.databaseSetup;
        const step = path.join(manifest.paths.output, "steps/0001");
        fs.mkdirSync(step, { recursive: true });
        fs.writeFileSync(
          path.join(step, "0001.json"),
          JSON.stringify({
            state: "SUCCEEDED",
            exitStatus: 0,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString()
          })
        );
        fs.writeFileSync(
          path.join(manifest.paths.output, "status.json"),
          JSON.stringify({
            contractVersion: "database-setup-status.v1",
            runId: manifest.runId,
            attemptId: manifest.attemptId,
            state: "SUCCEEDED",
            phase: "awaiting-normal-start",
            step: 0,
            optionSet: 0,
            capturedAt: new Date().toISOString(),
            code: "none"
          })
        );
        return super.provision(bundle);
      }
      async waitForDatabaseSetup(bundle: any, _cancel: any, progress: any) {
        trace.push("setup");
        if (mode === "normal") await new Promise((resolve) => setTimeout(resolve, 1200));
        const evidence = readDatabaseSetupEvidence(bundle.databaseSetup.manifest);
        progress(evidence);
        if (mode === "cancel-before-release")
          platform.coordinator.cancel(bundle.databaseSetup.manifest.runId);
        return evidence;
      }
      async startRemainingServices(bundle: any) {
        trace.push("remaining");
        const { manifest } = bundle.databaseSetup;
        assert.equal(
          fs.readFileSync(path.join(manifest.paths.control, "normal-start-release"), "utf8").trim(),
          `${manifest.runId}:${manifest.attemptId}`
        );
        assert.equal(
          platform.repositories.getRun(manifest.runId).environmentSnapshot.databaseSetupEvidence
            .state,
          "SUCCEEDED"
        );
      }
      async waitForReady(bundle: any, s: any, timeout: number, cancel?: () => boolean) {
        trace.push("normal-ready");
        if (mode === "normal") assert.equal(timeout, 1000);
        return super.waitForReady(bundle, s, timeout, cancel);
      }
      async cleanup(bundle: any, resources: any) {
        trace.push("cleanup");
        return super.cleanup(bundle, resources);
      }
    }
    const previousBudget = process.env.PARKBENCH_OPENEDGE_READINESS_TIMEOUT_MS;
    if (mode === "normal") process.env.PARKBENCH_OPENEDGE_READINESS_TIMEOUT_MS = "1000";
    const runner = new SetupRunner();
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
      { testMode: true, orchestrator: runner, phaseScale: 0 }
    );
    try {
      await platform.startupRecovery;
      const experiment = platform.coordinator.createExperiment(
        {
          scenario: { id: scenario.id, version: scenario.version },
          comparisonMode: "exploratory",
          repetitions: 1,
          variants: [
            {
              id: "v",
              name: "V",
              parameters: {},
              databaseSetup: {
                contractVersion: "database-setup.v1",
                steps: [
                  { id: "b", definitionId: "idxbuild", optionSets: [{ id: "all", scope: "all" }] }
                ]
              }
            }
          ],
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
        platform.repositories.getRun(experiment.runIds[0])!
      );
      if (mode === "normal") {
        assert(trace.includes("remaining"));
        assert(trace.indexOf("setup") < trace.indexOf("normal-ready"));
      } else {
        assert(!trace.includes("remaining"));
        assert(!trace.includes("normal-ready"));
      }
      assert(trace.includes("cleanup"));
      assert.equal(result.cleanupStatus, "COMPLETE");
      if (mode === "cancel-before-release") assert.equal(result.state, "CANCELLED");
      const manifest = result.environmentSnapshot.databaseSetupManifest;
      if (mode !== "normal")
        assert(!fs.existsSync(path.join(manifest.paths.control, "normal-start-release")));
    } finally {
      if (previousBudget === undefined) delete process.env.PARKBENCH_OPENEDGE_READINESS_TIMEOUT_MS;
      else process.env.PARKBENCH_OPENEDGE_READINESS_TIMEOUT_MS = previousBudget;
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
