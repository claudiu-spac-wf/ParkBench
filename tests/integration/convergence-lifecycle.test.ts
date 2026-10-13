import { savedRun } from "../helpers/saved-run";
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform, testObserverFactory } from "../../apps/control-plane/src/platform";
import { composeProjectName } from "../../packages/compose-runner/src/project-name";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import { MemoryPrometheusClient, calculateCompleteness } from "../../packages/metrics/src";

class RecordingPrometheusClient extends MemoryPrometheusClient {
  readonly rangeCalls: Array<{ query: string; step: number }> = [];
  readonly rawCalls: Array<{ query: string; step: number }> = [];
  override async queryRawRange(
    query: string,
    start: number,
    end: number,
    step: number,
    options = {}
  ) {
    this.rawCalls.push({ query, step });
    return super.queryRawRange(query, start, end, step, options);
  }

  override async queryRange(query: string, start: number, end: number, step: number) {
    this.rangeCalls.push({ query, step });
    return super.queryRange(query, start, end, step);
  }
}

const config = (root: string) => ({
  host: "127.0.0.1",
  port: 0,
  dbPath: ":memory:",
  artifactRoot: root,
  prometheusUrl: "http://localhost:9090",
  prometheusRetention: "7d",
  openedge: {}
});

const request = (variants: any[]) => ({
  scenario: { id: scenario.id, version: scenario.version },
  comparisonMode: "comparative" as const,
  baselineVariantId: "baseline",
  repetitions: 1,
  variants,
  inputs: {
    databaseImage:
      "openedge-db:12.8@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    pasImage:
      "openedge-pas:12.8@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    seed: "input:seed/fixture",
    applicationArchive: "input:archive/fixture"
  }
});

async function waitFor(check: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(check(), true);
}

describe("convergence lifecycle", () => {
  for (const [phase, expectedState] of [
    ["MEASURING", "interrupted"],
    ["COOLDOWN", "completed"]
  ] as const) {
    it(`records ${expectedState} measurement when cancelled during ${phase}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-cancel-window-"));
      const platform = createPlatform(config(root), {
        testMode: true,
        prometheus: new MemoryPrometheusClient(),
        orchestrator: new FakeRunOrchestrator(),
        observerFactory: testObserverFactory(),
        phaseScale: 0.01
      });
      try {
        platform.scenarios.register(scenario as any);
        const experiment = platform.coordinator.createExperiment(
          request([{ id: "baseline", name: "Baseline", parameters: {} }]) as any,
          scenario as any
        );
        const id = experiment.runIds[0];
        const execution = platform.coordinator.executeRun(platform.repositories.getRun(id)!);
        await waitFor(() => platform.repositories.getRun(id)?.state === phase, 2000);
        platform.coordinator.cancel(id);
        const run = await execution;
        assert.equal(run.state, "CANCELLED");
        assert.equal(
          savedRun(root, platform.repositories, id).summary.windows.measurement.state,
          expectedState
        );
      } finally {
        platform.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
  it("runs owned resources through export, summary, and cleanup in order", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-convergence-"));
    const orchestrator = new FakeRunOrchestrator();
    const platform = createPlatform(config(root), {
      testMode: true,
      prometheus: new MemoryPrometheusClient(),
      orchestrator,
      observerFactory: testObserverFactory(),
      phaseScale: 0
    });
    platform.scenarios.register(scenario as any);
    const experiment = platform.coordinator.createExperiment(
      request([{ id: "baseline", name: "Baseline", parameters: {} }]) as any,
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(run.state, "INCOMPLETE");
    assert.equal(run.composeProject, composeProjectName(run.id));
    assert.ok(run.phaseBoundaries?.measurement?.startedAt);
    assert.ok(run.phaseBoundaries?.measurement?.finishedAt);
    assert.deepEqual(orchestrator.calls, [
      "provision",
      "ready",
      "start-workload",
      "wait-workload",
      "stop-workload",
      "collect-logs",
      "cleanup"
    ]);
    assert.equal(
      platform.repositories
        .listResources(run.id)
        .every((resource: any) => resource.cleanupResult === "deleted"),
      true
    );
    const kinds = platform.repositories.listArtifacts(run.id).map((artifact) => artifact.kind);
    for (const kind of ["compose_bundle", "log", "run_context", "run_comparison_summary"])
      assert.equal(kinds.includes(kind as any), true, `missing ${kind}`);
    for (const retired of [
      "run_evidence",
      "observer_report",
      "load_summary",
      "raw_prometheus_timeseries"
    ])
      assert.equal(kinds.includes(retired as any), false);
    const { summary, context } = savedRun(root, platform.repositories, run.id);
    assert.equal(summary.contractVersion, "run-summary.v1");
    assert.ok(Array.isArray(summary.metricsReference.queries));
    assert.equal(summary.quality.cleanupStatus, "COMPLETE");
    assert.equal(context.observed.cleanupStatus, "COMPLETE");
    platform.close();
  });

  it("continues later matrix cells after incomplete results", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-matrix-"));
    const platform = createPlatform(config(root), {
      testMode: true,
      prometheus: new MemoryPrometheusClient(),
      orchestrator: new FakeRunOrchestrator(),
      observerFactory: testObserverFactory(),
      phaseScale: 0
    });
    platform.scenarios.register(scenario as any);
    const experiment = platform.coordinator.createExperiment(
      request([
        { id: "baseline", name: "Baseline", parameters: {} },
        { id: "variant", name: "Variant", parameters: {} },
        { id: "variant-two", name: "Variant Two", parameters: {} }
      ]) as any,
      scenario as any
    );
    platform.coordinator.setBehavior(experiment.runIds[0], { missingRequiredObserver: true });
    platform.coordinator.setBehavior(experiment.runIds[1], { terminalState: "THRESHOLD_FAILED" });
    platform.coordinator.startExperiment(experiment.id);
    await waitFor(() => platform.repositories.getExperiment(experiment.id)?.status === "PARTIAL");
    const runs = platform.repositories.listRuns(experiment.id);
    assert.deepEqual(
      runs.map((run) => run.state),
      ["INCOMPLETE", "THRESHOLD_FAILED", "INCOMPLETE"]
    );
    platform.close();
  });

  it("runs the remaining runs after an infrastructure failure and ends the experiment FAILED", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-matrix-failed-"));
    const platform = createPlatform(config(root), {
      testMode: true,
      prometheus: new MemoryPrometheusClient(),
      orchestrator: new FakeRunOrchestrator(),
      observerFactory: testObserverFactory(),
      phaseScale: 0
    });
    platform.scenarios.register(scenario as any);
    const experiment = platform.coordinator.createExperiment(
      request([
        { id: "baseline", name: "Baseline", parameters: {} },
        { id: "variant", name: "Variant", parameters: {} },
        { id: "variant-two", name: "Variant Two", parameters: {} }
      ]) as any,
      scenario as any
    );
    platform.coordinator.setBehavior(experiment.runIds[0], { readinessFailure: true });
    platform.coordinator.startExperiment(experiment.id);
    await waitFor(() => platform.repositories.getExperiment(experiment.id)?.status === "FAILED");
    const runs = platform.repositories.listRuns(experiment.id);
    assert.deepEqual(
      runs.map((run) => run.state),
      ["FAILED", "INCOMPLETE", "INCOMPLETE"]
    );
    platform.close();
  });

  it("marks a run incomplete when required disk I/O samples disappear", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-disk-gap-"));
    const platform = createPlatform(config(root), {
      testMode: true,
      prometheus: new MemoryPrometheusClient(),
      orchestrator: new FakeRunOrchestrator(),
      observerFactory: testObserverFactory(),
      phaseScale: 0,
      requiredDiskIo: true
    });
    platform.scenarios.register(scenario as any);
    const experiment = platform.coordinator.createExperiment(
      request([{ id: "baseline", name: "Baseline", parameters: {} }]) as any,
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(run.state, "INCOMPLETE");
    assert.match(run.failureReason ?? "", /disk-io-/);
    assert.equal(
      run.completeness?.requiredGaps.some((gap) => gap.observerId.startsWith("disk-io-cadvisor")),
      true
    );
    platform.close();
  });

  it("checks required disk I/O at the configured Prometheus scrape cadence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-disk-cadence-"));
    const prometheus = new RecordingPrometheusClient();
    const platform = createPlatform(
      { ...config(root), prometheusScrapeIntervalSeconds: 5 } as any,
      {
        testMode: true,
        prometheus,
        orchestrator: new FakeRunOrchestrator(),
        observerFactory: testObserverFactory(),
        phaseScale: 0,
        requiredDiskIo: true
      }
    );
    platform.scenarios.register(scenario as any);
    const experiment = platform.coordinator.createExperiment(
      request([{ id: "baseline", name: "Baseline", parameters: {} }]) as any,
      scenario as any
    );

    try {
      const measured = platform.repositories.getRun(experiment.runIds[0])!;
      measured.phaseBoundaries = {
        measurement: {
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(10000).toISOString()
        }
      };
      await (platform.coordinator as any).collectDiskIoCompleteness(measured, 10, {
        resources: [
          { name: "database", type: "container" },
          { name: "pas-1", type: "container" }
        ]
      });
      const diskCalls = prometheus.rawCalls
        .filter((call) => /^(container_fs_|node_disk_)/.test(call.query))
        .slice(0, 9);
      assert.equal(diskCalls.length, 9);
      assert.equal(
        diskCalls.every((call) => call.step === 5),
        true
      );
    } finally {
      platform.close();
    }
  });

  it("does not let one owned disk series mask a missing container series", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-disk-series-gap-"));
    const prometheus = new MemoryPrometheusClient();
    const platform = createPlatform(config(root), {
      testMode: true,
      prometheus,
      orchestrator: new FakeRunOrchestrator(),
      observerFactory: testObserverFactory(),
      phaseScale: 0,
      requiredDiskIo: true
    });
    platform.scenarios.register(scenario as any);
    const experiment = platform.coordinator.createExperiment(
      request([{ id: "baseline", name: "Baseline", parameters: {} }]) as any,
      scenario as any
    );
    const run = platform.repositories.getRun(experiment.runIds[0])!;
    const timestamp = Date.now() / 1000;
    const common = {
      experiment_id: experiment.id,
      run_id: run.id,
      variant_id: run.variantId,
      repetition: "1",
      phase: "measurement"
    };
    prometheus.samples.push(
      {
        metricName: "container_fs_reads_bytes_total",
        labels: {
          ...common,
          component: "container",
          service: "database",
          job: "parkbench-run-owned-cadvisor"
        } as any,
        timestamp,
        value: 1,
        source: "cadvisor"
      },
      {
        metricName: "container_fs_writes_bytes_total",
        labels: {
          ...common,
          component: "container",
          service: "database",
          job: "parkbench-run-owned-cadvisor"
        } as any,
        timestamp,
        value: 1,
        source: "cadvisor"
      },
      {
        metricName: "node_disk_read_bytes_total",
        labels: { ...common, component: "host", service: "node-exporter", device: "vda" } as any,
        timestamp,
        value: 1,
        source: "node-exporter:block-device"
      },
      {
        metricName: "node_disk_written_bytes_total",
        labels: { ...common, component: "host", service: "node-exporter", device: "vda" } as any,
        timestamp,
        value: 1,
        source: "node-exporter:block-device"
      },
      {
        metricName: "node_disk_written_bytes_total",
        labels: { ...common, component: "host", service: "node-exporter", device: "vdb" } as any,
        timestamp,
        value: 1,
        source: "node-exporter:block-device"
      }
    );
    run.phaseBoundaries = {
      measurement: {
        startedAt: new Date((timestamp - 1) * 1000).toISOString(),
        finishedAt: new Date((timestamp + 1) * 1000).toISOString()
      }
    };
    const counts = await (platform.coordinator as any).collectDiskIoCompleteness(run, 2, {
      resources: ["database", "pas-1", "loadgen", "db-observer"].map((name) => ({
        name,
        type: "container"
      }))
    });
    const completed = { completeness: calculateCompleteness(counts) };
    assert.equal(completed.completeness.complete, false);
    assert.equal(
      completed.completeness?.requiredGaps.some(
        (gap) => gap.observerId === "disk-io-cadvisor-read:pas-1"
      ),
      true
    );
    assert.equal(
      completed.completeness?.requiredGaps.some(
        (gap) => gap.observerId === "disk-io-node-exporter-read:vdb"
      ),
      true
    );
    assert.equal(
      completed.completeness?.requiredGaps.some((gap) =>
        /:(?:loadgen|db-observer|pas-observer|file-sampler)$/.test(gap.observerId)
      ),
      false
    );
    assert.equal(
      completed.completeness?.requiredGaps.some((gap) =>
        gap.observerId.startsWith("disk-io-cadvisor-io-time:")
      ),
      false
    );
    platform.close();
  });

  it("exports after workload-stop failure and records cleanup failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-terminal-errors-"));
    const orchestrator = new FakeRunOrchestrator();
    orchestrator.stopFailure = true;
    orchestrator.cleanupFailure = true;
    const platform = createPlatform(config(root), {
      testMode: true,
      prometheus: new MemoryPrometheusClient(),
      orchestrator,
      observerFactory: testObserverFactory(),
      phaseScale: 0
    });
    platform.scenarios.register(scenario as any);
    const experiment = platform.coordinator.createExperiment(
      request([{ id: "baseline", name: "Baseline", parameters: {} }]) as any,
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(run.state, "INCOMPLETE");
    assert.equal(run.cleanupStatus, "FAILED");
    assert.equal(
      platform.repositories
        .listArtifacts(run.id)
        .some((artifact) => artifact.kind === "raw_prometheus_timeseries"),
      false
    );
    assert.equal(
      platform.repositories
        .listArtifacts(run.id)
        .some((artifact) => artifact.kind === "diagnostics"),
      true
    );
    platform.close();
  });

  it("runs later matrix cells after one run is cancelled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-cancel-"));
    const platform = createPlatform(config(root), {
      testMode: true,
      prometheus: new MemoryPrometheusClient(),
      orchestrator: new FakeRunOrchestrator(),
      observerFactory: testObserverFactory(),
      phaseScale: 0
    });
    platform.scenarios.register(scenario as any);
    const experiment = platform.coordinator.createExperiment(
      request([
        { id: "baseline", name: "Baseline", parameters: {} },
        { id: "variant", name: "Variant", parameters: {} }
      ]) as any,
      scenario as any
    );
    platform.coordinator.startExperiment(experiment.id);
    platform.coordinator.cancel(experiment.runIds[0]);
    await waitFor(() => platform.repositories.getExperiment(experiment.id)?.status === "CANCELLED");
    const runs = platform.repositories.listRuns(experiment.id);
    assert.equal(runs.find((run) => run.id === experiment.runIds[0])?.state, "CANCELLED");
    // Cancelling one run no longer leaves the rest of the experiment stuck in the queue.
    assert.equal(runs.find((run) => run.id === experiment.runIds[1])?.state, "INCOMPLETE");
    assert.equal(
      platform.repositories
        .listEvents(experiment.runIds[0])
        .some((event) => event.actor === "operator"),
      true
    );
    platform.close();
  });
});
