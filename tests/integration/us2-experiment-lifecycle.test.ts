import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  shouldContinueAfterRun,
  shouldStopMatrix
} from "../../apps/control-plane/src/experiments/failure-policy";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator, generateRunCompose } from "../../packages/compose-runner/src";

class BlockingReadyOrchestrator extends FakeRunOrchestrator {
  override async waitForReady(
    _bundle?: any,
    _scenario?: any,
    _timeoutMs?: number,
    isCancelled?: () => boolean
  ): Promise<void> {
    this.calls.push("ready");
    while (!isCancelled?.()) await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error("run_cancelled");
  }
}

class TimeoutWorkloadOrchestrator extends FakeRunOrchestrator {
  override async waitForWorkload(): Promise<number> {
    this.calls.push("wait-workload");
    return 40;
  }
}

async function waitFor(check: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
}
describe("experiment lifecycle", () => {
  it("continues after incomplete, threshold, failed and cancelled runs; stops only when interrupted", () => {
    assert.equal(shouldContinueAfterRun("INCOMPLETE"), true);
    assert.equal(shouldContinueAfterRun("THRESHOLD_FAILED"), true);
    assert.equal(shouldContinueAfterRun("FAILED"), true);
    assert.equal(shouldStopMatrix("FAILED"), false);
    assert.equal(shouldStopMatrix("CANCELLED"), false);
    assert.equal(shouldStopMatrix("INTERRUPTED"), true);
  });

  it("applies validated variant factors to database, PAS, and resource settings", () => {
    const bundle = generateRunCompose(
      "run-parameters",
      "exp-parameters",
      scenario as any,
      {
        db: "openedge-db:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        pas: "openedge-pas:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      },
      {
        parameters: {
          "-B": 10000,
          "pas.maxThreads": 32,
          "database.readOnly": true,
          "database.cpuLimit": 2,
          "pas.cpuLimit": 1
        },
        variantId: "variant",
        repetition: 2,
        loadgenImage:
          "parkbench/loadgen:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        observerImage:
          "parkbench/observer:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      }
    );
    assert.match(bundle.file, /PARKBENCH_DATABASE_ARGV_FILE/);
    assert.equal(bundle.brokerArgv,"-B\n10000\n");
    assert.match(bundle.file, /PARKBENCH_PAS_MAX_THREADS: "32"/);
    assert.match(bundle.file, /PARKBENCH_DATABASE_READ_ONLY: "true"/);
    assert.match(bundle.file, /PARKBENCH_VARIANT_ID: "variant"/);
    assert.match(bundle.file, /PARKBENCH_REPETITION: "2"/);
    assert.equal((bundle.file.match(/cpus: /g) ?? []).length, 2);
  });

  it("finalizes cancellation requested during readiness as CANCELLED", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-cancel-readiness-"));
    const orchestrator = new BlockingReadyOrchestrator();
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
      { testMode: true, orchestrator, phaseScale: 0 }
    );
    platform.scenarios.register(scenario as any);
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "cancel", name: "Cancel", parameters: {} }],
        inputs: {
          databaseImage:
            "db:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          pasImage:
            "pas:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      } as any,
      scenario as any
    );
    platform.coordinator.startExperiment(experiment.id);
    await waitFor(() => orchestrator.calls.includes("ready"));
    platform.coordinator.cancel(experiment.runIds[0]);
    await waitFor(() => platform.repositories.getExperiment(experiment.id)?.status === "CANCELLED");
    const run = platform.repositories.getRun(experiment.runIds[0])!;
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.failureKind, "cancellation");
    assert.equal(run.failureReason, "operator requested cancellation");
    platform.close();
  });

  it("marks a loadgen timeout as FAILED and cleans up the run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-timeout-run-"));
    const orchestrator = new TimeoutWorkloadOrchestrator();
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
      { testMode: true, orchestrator, phaseScale: 0, requiredDiskIo: false }
    );
    platform.scenarios.register(scenario as any);
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "timeout", name: "Timeout", parameters: {} }],
        inputs: {
          databaseImage:
            "db:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          pasImage:
            "pas:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      } as any,
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(run.state, "FAILED");
    assert.equal(run.failureKind, "infrastructure");
    assert.match(run.failureReason ?? "", /loadgen exited with code 40/);
    assert.equal(run.cleanupStatus, "COMPLETE");
    assert.ok(orchestrator.calls.includes("stop-workload"));
    assert.ok(orchestrator.calls.includes("cleanup"));
    platform.close();
  });
});
