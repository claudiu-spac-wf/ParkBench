import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import { FileDiscovery } from "../../packages/metrics/src/discovery";

it("production coordinator completes readiness once and collects adjacent phases on stable targets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-continuous-"));
  const waits: string[] = [];
  let readyAt = 0;
  class Prometheus extends MemoryPrometheusClient {
    async waitForRunTargets(_run: string, phase: string) {
      waits.push(phase);
      await new Promise((resolve) => setTimeout(resolve, 70));
      readyAt = Date.now();
    }
  }
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://unused",
      prometheusRetention: "7d",
      prometheusScrapeIntervalSeconds: 0.05,
      openedge: {}
    },
    { testMode: true, phaseScale: 0.005, prometheus: new Prometheus() }
  );
  const originalUpdate = FileDiscovery.prototype.updatePhase;
  const originalAdd = FileDiscovery.prototype.add;
  let relabels = 0;
  let labels: any[] = [];
  FileDiscovery.prototype.updatePhase = function (...args) {
    relabels++;
    return originalUpdate.apply(this, args);
  };
  FileDiscovery.prototype.add = function (runId, targets) {
    labels = targets.map((t) => t.labels);
    return originalAdd.call(this, runId, targets);
  };
  try {
    await platform.startupRecovery;
    const short = {
      ...scenario,
      phases: { warmupSeconds: 30, measurementSeconds: 120, cooldownSeconds: 10 }
    };
    platform.scenarios.register(short as any);
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: short.id, version: short.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "one", name: "One", parameters: {} }],
        inputs: {
          databaseImage: "db:fixture",
          pasImage: "pas:fixture",
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      } as any,
      short as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.ok(run.phaseBoundaries?.cooldown, run.failureReason);
    assert.equal(
      run.phaseBoundaries.warmup?.finishedAt,
      run.phaseBoundaries.measurement?.startedAt
    );
    assert.equal(
      run.phaseBoundaries.measurement?.finishedAt,
      run.phaseBoundaries.cooldown?.startedAt
    );
    assert.equal(
      Date.parse(run.phaseBoundaries.measurement!.finishedAt!) -
        Date.parse(run.phaseBoundaries.measurement!.startedAt!),
      600
    );
    assert.equal(
      Date.parse(run.phaseBoundaries.cooldown!.finishedAt!) - Date.parse(run.phaseBoundaries.warmup!.startedAt!),
      800
    );
    assert.ok(Date.parse(run.phaseBoundaries.warmup!.startedAt!) >= readyAt);
    assert.deepEqual(waits, [""]);
    assert.equal(relabels, 0);
    assert.ok(labels.length > 0);
    assert.ok(labels.every((label) => !Object.hasOwn(label, "phase")));
    assert.equal(run.cleanupStatus, "COMPLETE");
    assert.equal((run.environmentSnapshot as any).metricsCollectionMode, "continuous");
  } finally {
    FileDiscovery.prototype.updatePhase = originalUpdate;
    FileDiscovery.prototype.add = originalAdd;
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
