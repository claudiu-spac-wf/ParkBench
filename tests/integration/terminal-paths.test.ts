import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { retryPendingCleanup } from "../../apps/control-plane/src/runs/recovery";
import { FileDiscovery } from "../../packages/metrics/src/discovery";
import {
  DockerComposeOrchestrator,
  generateRunCompose,
  ownershipLabels
} from "../../packages/compose-runner/src";
describe("terminal finalization", () => {
  it("retains named gaps and cleanup when every summary source fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-export-"));
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
      { testMode: true, phaseScale: 0.01 }
    );
    await platform.startupRecovery;
    const experiment: any = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "variant", name: "Variant", parameters: {} }],
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
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!,
      { exportFailure: true }
    );
    assert.equal(run.state, "FAILED");
    assert.equal(run.failureCode, "named_latch_evidence_missing");
    assert.equal(run.failureKind, "observer");
    assert.equal(run.measurementValidity, "UNAVAILABLE");
    const cache = platform.repositories.getSummaryCache(run.id);
    assert.equal(cache.status, "READY");
    assert.ok(cache.header.quality.requiredGaps.length > 0);
    assert.equal(run.cleanupStatus, "COMPLETE");
    assert.ok(
      platform.repositories
        .pageSummaryRows(run.id)
        .rows.some((row) => row.statistics.average?.reasons.includes("source_unavailable"))
    );
    platform.close();
  });

  it("does not mark a temporary directory deleted before filesystem verification", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-cleanup-verify-"));
    const temporaryDirectory = fs.mkdtempSync(path.join(root, "owned-"));
    const bundle = generateRunCompose(
      "run-cleanup-verify",
      "exp-cleanup-verify",
      scenario as any,
      {
        db: "db:fixture",
        pas: "pas:fixture"
      },
      {
        loadgenImage:
          "parkbench/loadgen:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        observerImage:
          "parkbench/observer:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      }
    );
    const resource: any = {
      resourceType: "temporary_directory",
      resourceId: temporaryDirectory,
      labels: ownershipLabels("run-cleanup-verify", "exp-cleanup-verify", "temporary"),
      createdAt: new Date().toISOString()
    };
    const cleaned = await new DockerComposeOrchestrator(root, "true").cleanup(bundle, [resource]);
    assert.equal(cleaned[0].deletedAt, undefined);
    assert.match(cleaned[0].cleanupResult, /cleanup_verification_failed/);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("removes the final target file and retries terminal cleanup on restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-cleanup-retry-"));
    const discovery = new FileDiscovery(path.join(root, "active-runs.json"));
    discovery.add("run-cleanup-retry", [
      {
        targets: ["loadgen:9100"],
        labels: { run_id: "run-cleanup-retry" } as any
      }
    ]);
    discovery.remove("run-cleanup-retry");
    assert.equal(fs.existsSync(discovery.filePath), false);

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
    await platform.startupRecovery;
    const experiment: any = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "retry", name: "Retry", parameters: {} }],
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
    const run = platform.repositories.getRun(experiment.runIds[0])!;
    run.state = "FAILED";
    run.cleanupStatus = "FAILED";
    platform.repositories.saveRun(run);
    let retried = false;
    assert.equal(
      await retryPendingCleanup(platform.repositories, async (_run, stage) => {
        retried = stage === "cleanup";
      }),
      1
    );
    assert.equal(retried, true);
    assert.equal(platform.repositories.getRun(run.id)?.cleanupStatus, "COMPLETE");
    platform.close();
  });
});
describe("terminal finalization", () => {
  it("exports every terminal state before cleanup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-terminal-"));
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
    for (const state of [
      "SUCCEEDED",
      "THRESHOLD_FAILED",
      "FAILED",
      "CANCELLED",
      "INCOMPLETE",
      "INTERRUPTED"
    ] as any[]) {
      const experiment: any = platform.coordinator.createExperiment(
        {
          scenario: { id: scenario.id, version: scenario.version },
          comparisonMode: "exploratory",
          repetitions: 1,
          variants: [{ id: `variant-${state}`, name: state, parameters: {} }],
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
      const run = await platform.coordinator.executeRun(
        platform.repositories.getRun(experiment.runIds[0])!,
        { terminalState: state }
      );
      assert.equal(run.state, state === "SUCCEEDED" ? "INCOMPLETE" : state);
      assert.equal(
        platform.repositories
          .listArtifacts(run.id)
          .some((artifact) => artifact.kind === "raw_prometheus_timeseries"),
        false
      );
    }
    platform.close();
  });
});
