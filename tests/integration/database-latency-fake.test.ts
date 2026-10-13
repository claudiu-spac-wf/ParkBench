import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import type { ComposeBundle } from "../../packages/compose-runner/src/run-compose";
import type { RunResource } from "../../packages/compose-runner/src/resources";

const images = {
  databaseImage: `db:fixture@sha256:${"0123456789abcdef".repeat(4)}`,
  pasImage: `pas:fixture@sha256:${"abcdef0123456789".repeat(4)}`,
  seed: "input:seed/fixture",
  applicationArchive: "input:archive/fixture"
};

class RecordingOrchestrator extends FakeRunOrchestrator {
  cleaned: string[] = [];
  onLatency?: (runId: string) => void;
  override async applyDatabaseLatency(
    ...args: Parameters<FakeRunOrchestrator["applyDatabaseLatency"]>
  ) {
    const evidence = await super.applyDatabaseLatency(...args);
    this.onLatency?.(args[0].resources[0]?.labels["parkbench.run_id"] ?? "");
    return evidence;
  }
  override async cleanup(bundle: ComposeBundle, resources: RunResource[]) {
    this.cleaned.push(...resources.map((resource) => resource.resourceId));
    return super.cleanup(bundle, resources);
  }
}

async function runWithLatency(
  latency: number | undefined,
  configure?: (o: RecordingOrchestrator, p: any) => void
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-latency-"));
  const orchestrator = new RecordingOrchestrator();
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
  configure?.(orchestrator, platform);
  try {
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [
          {
            id: "v1",
            name: "Variant",
            parameters: latency === undefined ? {} : { "network.databaseLatencyMs": latency }
          }
        ],
        inputs: images
      },
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    const artifacts = platform.repositories
      .listArtifacts(run.id)
      .map((artifact: any) => artifact.kind);
    return { run, orchestrator, artifacts };
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("Database Latency in fake mode", () => {
  it("records simulated evidence before the workload starts", async () => {
    const { run, orchestrator, artifacts } = await runWithLatency(20);
    const evidence = (run.environmentSnapshot as any).databaseLatency;
    assert.deepEqual(
      {
        contractVersion: evidence.contractVersion,
        requestedMs: evidence.requestedMs,
        appliedMs: evidence.appliedMs,
        mode: evidence.mode,
        status: evidence.status
      },
      {
        contractVersion: "db-latency.v1",
        requestedMs: 20,
        appliedMs: 20,
        mode: "simulated",
        status: "simulated"
      }
    );
    assert.ok(artifacts.includes("database_latency"));
    const latencyIndex = orchestrator.calls.indexOf("applyDatabaseLatency");
    assert.ok(latencyIndex > orchestrator.calls.indexOf("ready"));
    assert.ok(latencyIndex < orchestrator.calls.indexOf("start-workload"));
    assert.notEqual(run.state, "FAILED");
  });

  it("skips the step for latency 0 and absent latency", async () => {
    for (const latency of [0, undefined]) {
      const { run, orchestrator, artifacts } = await runWithLatency(latency);
      const evidence = (run.environmentSnapshot as any).databaseLatency;
      assert.equal(evidence.mode, "none");
      assert.equal(evidence.status, "not_requested");
      assert.equal(evidence.appliedMs, 0);
      assert.deepEqual(evidence.targets, []);
      assert.equal(orchestrator.calls.includes("applyDatabaseLatency"), false);
      assert.equal(artifacts.includes("database_latency"), false);
    }
  });

  it("fails before warmup and still cleans up when latency cannot be applied", async () => {
    const { run, orchestrator } = await runWithLatency(5, (o) => {
      o.latencyFailure = "database_latency_unsupported";
    });
    assert.equal(run.state, "FAILED");
    assert.equal(run.failureCode, "database_latency_unsupported");
    assert.match(String(run.failureReason), /sch_netem/);
    assert.equal(orchestrator.calls.includes("start-workload"), false);
    assert.ok(orchestrator.calls.includes("cleanup"));
    assert.ok(orchestrator.cleaned.includes("latency-database"));
    const evidence = (run.environmentSnapshot as any).databaseLatency;
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failureCode, "database_latency_unsupported");
  });

  it("cleans up after a cancellation that follows the latency step", async () => {
    const { run, orchestrator } = await runWithLatency(20, (o, platform) => {
      o.onLatency = (runId) => platform.coordinator.cancel(runId);
    });
    assert.equal(run.state, "CANCELLED");
    assert.ok(orchestrator.calls.includes("cleanup"));
    assert.ok(orchestrator.cleaned.includes("latency-database"));
    assert.ok(orchestrator.cleaned.includes("latency-pas-1"));
    assert.equal(orchestrator.calls.includes("start-workload"), false);
  });
});
