import { savedRun } from "../helpers/saved-run";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";

/** Run series stay in Prometheus: no export is written, and evidence records where they are. */
function metricsReference(root: string, runId: string, repositories: any): any {
  assert.equal(fs.existsSync(path.join(root, runId, "raw-prometheus.jsonl.gz")), false);
  assert.equal(fs.existsSync(path.join(root, runId, "manifest.json")), false);
  const { summary, context } = savedRun(root, repositories, runId);
  assert.equal(summary.contractVersion, "run-summary.v1");
  assert.equal(context.contractVersion, "run-context.v1");
  assert.equal(fs.existsSync(path.join(root, runId, "run-evidence.json")), false);
  return {
    measurementState: summary.windows.measurement.state,
    measurementWindow:
      summary.windows.measurement.state === "not_started" ? null : summary.windows.measurement,
    ...summary.metricsReference
  };
}

const images = {
  databaseImage: `db:fixture@sha256:${"0123456789abcdef".repeat(4)}`,
  pasImage: `pas:fixture@sha256:${"abcdef0123456789".repeat(4)}`,
  seed: "input:seed/fixture",
  applicationArchive: "input:archive/fixture"
};

test("a real database run without a manifest attempts capture before workload", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-required-capture-"));
  const originalFetch = globalThis.fetch;
  const orchestrator = new FakeRunOrchestrator();
  let attempts = 0;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/parameter-capture$/);
    attempts += 1;
    return new Response(
      JSON.stringify({
        contractVersion: "openedge-db-parameter-capture.v1",
        databaseName: "parkbench",
        attemptedAt: "2026-09-28T10:00:00.000Z",
        capturedAt: "2026-09-28T10:00:00.000Z",
        source: "_DbParams",
        status: "complete",
        rows: []
      }),
      { status: 200 }
    );
  };
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
    { testMode: true, orchestrator, phaseScale: 0, requireParameterCapture: true }
  );
  try {
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "v1", name: "Variant", parameters: {} }],
        inputs: images
      },
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(attempts, 1);
    assert.equal((run.environmentSnapshot as any).parameterSnapshotCapture.state, "captured");
    assert.equal(orchestrator.calls.includes("start-workload"), true);
  } finally {
    globalThis.fetch = originalFetch;
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable required capture stops before workload with a named gap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-unavailable-capture-"));
  const originalFetch = globalThis.fetch;
  const orchestrator = new FakeRunOrchestrator();
  globalThis.fetch = async () => {
    throw new Error("observer_unreachable");
  };
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
    { testMode: true, orchestrator, phaseScale: 0, requireParameterCapture: true }
  );
  try {
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "v1", name: "Variant", parameters: {} }],
        inputs: images
      },
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(run.state, "FAILED");
    assert.equal(orchestrator.calls.includes("start-workload"), false);
    assert.equal(
      (run.environmentSnapshot as any).parameterSnapshotCapture.reasonCode,
      "observer_unavailable"
    );
  } finally {
    globalThis.fetch = originalFetch;
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mismatch persists one plaintext snapshot and its Prometheus series before workload start", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-parameter-run-"));
  const orchestrator = new FakeRunOrchestrator();
  const prometheus = new MemoryPrometheusClient();
  let reads = 0;
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
      orchestrator,
      prometheus,
      phaseScale: 0,
      parameterCapture: async () => {
        reads += 1;
        return {
          contractVersion: "openedge-db-parameter-capture.v1",
          databaseName: "parkbench",
          attemptedAt: "2026-09-28T10:00:00.000Z",
          capturedAt: "2026-09-28T10:00:00.000Z",
          source: "_DbParams",
          status: "complete",
          rows: [{ name: "-B", rawValue: "500", dtype: 4, isDefault: false }]
        };
      }
    }
  );
  try {
    const startup = {
      contractVersion: "db-startup-parameters.v1" as const,
      databaseName: "parkbench",
      startupFile: { status: "absent" as const },
      parameters: [
        {
          name: "-B",
          displayValue: "1000",
          source: "queued" as const,
          overrides: [],
          applicability: "database_broker" as const,
          verification: "pending" as const
        }
      ]
    };
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [
          { id: "v1", name: "Variant", parameters: { "-B": 1000 }, databaseStartup: startup }
        ],
        inputs: images
      },
      scenario as any
    );
    const queued = platform.repositories.getRun(experiment.runIds[0])!;
    const completed = await platform.coordinator.executeRun(queued);
    assert.equal(completed.state, "FAILED");
    assert.equal(completed.failureCode, "database_parameter_unapplied");
    assert.equal(reads, 1);
    assert.equal(orchestrator.calls.includes("start-workload"), false);
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(root, queued.id, "db-parameter-snapshot.json"), "utf8")
    );
    assert.equal(snapshot.rows[0].displayValue, "500");
    assert.equal(snapshot.verificationResults[0].observedValue, "500");
    assert.equal(snapshot.verificationResults[0].verification, "mismatched");
    const metrics = metricsReference(root, queued.id, platform.repositories);
    assert.equal(metrics.measurementState, "not_started");
    assert.equal(metrics.measurementWindow, null);
    assert.ok(
      prometheus.samples.some(
        (sample) =>
          sample.metricName === "parkbench_openedge_db_parameter_snapshot_info" &&
          sample.labels.run_id === queued.id &&
          sample.labels.display_value === "500"
      )
    );
    assert.ok(
      platform.repositories
        .listArtifacts(queued.id)
        .some((item) => item.kind === "db_parameter_snapshot")
    );
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matched startup capture is reused and the run records its measurement window in Prometheus", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-parameter-success-"));
  const orchestrator = new FakeRunOrchestrator();
  const prometheus = new MemoryPrometheusClient();
  let reads = 0;
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
      orchestrator,
      prometheus,
      phaseScale: 0,
      parameterCapture: async () => {
        reads += 1;
        return {
          contractVersion: "openedge-db-parameter-capture.v1",
          databaseName: "parkbench",
          attemptedAt: "2026-09-28T10:00:00.000Z",
          capturedAt: "2026-09-28T10:00:00.000Z",
          source: "_DbParams",
          status: "complete",
          rows: [{ name: "-B", rawValue: "1000", dtype: 4, isDefault: false }]
        };
      }
    }
  );
  try {
    const startup = {
      contractVersion: "db-startup-parameters.v1" as const,
      databaseName: "parkbench",
      startupFile: { status: "absent" as const },
      parameters: [
        {
          name: "-B",
          displayValue: "1000",
          source: "queued" as const,
          overrides: [],
          applicability: "database_broker" as const,
          verification: "pending" as const
        }
      ]
    };
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [
          { id: "v1", name: "Variant", parameters: { "-B": 1000 }, databaseStartup: startup }
        ],
        inputs: images
      },
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(reads, 1);
    assert.equal(orchestrator.calls.includes("start-workload"), true);
    assert.ok(run.phaseBoundaries?.measurement?.startedAt);
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(root, run.id, "db-parameter-snapshot.json"), "utf8")
    );
    assert.equal(snapshot.verificationResults[0].verification, "matched");
    const metrics = metricsReference(root, run.id, platform.repositories);
    assert.equal(metrics.measurementState, "completed");
    assert.ok(metrics.measurementWindow.start);
    assert.ok(metrics.measurementWindow.end);
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("captured startup samples survive failed and cancelled measured runs", async () => {
  for (const terminalState of ["FAILED", "CANCELLED"] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-parameter-terminal-"));
    const orchestrator = new FakeRunOrchestrator();
    const prometheus = new MemoryPrometheusClient();
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
        orchestrator,
        prometheus,
        phaseScale: 0,
        parameterCapture: async () => ({
          contractVersion: "openedge-db-parameter-capture.v1",
          databaseName: "parkbench",
          attemptedAt: "2026-09-28T10:00:00.000Z",
          capturedAt: "2026-09-28T10:00:00.000Z",
          source: "_DbParams",
          status: "complete",
          rows: [{ name: "-B", rawValue: "1000", dtype: 4, isDefault: false }]
        })
      }
    );
    try {
      const startup = {
        contractVersion: "db-startup-parameters.v1" as const,
        databaseName: "parkbench",
        startupFile: { status: "absent" as const },
        parameters: [
          {
            name: "-B",
            displayValue: "1000",
            source: "queued" as const,
            overrides: [],
            applicability: "database_broker" as const,
            verification: "pending" as const
          }
        ]
      };
      const experiment = platform.coordinator.createExperiment(
        {
          scenario: { id: scenario.id, version: scenario.version },
          comparisonMode: "exploratory",
          repetitions: 1,
          variants: [
            { id: "v1", name: "Variant", parameters: { "-B": 1000 }, databaseStartup: startup }
          ],
          inputs: images
        },
        scenario as any
      );
      const run = await platform.coordinator.executeRun(
        platform.repositories.getRun(experiment.runIds[0])!,
        { terminalState }
      );
      assert.equal(run.state, terminalState);
      const metrics = metricsReference(root, run.id, platform.repositories);
      assert.equal(metrics.measurementState, "completed");
      assert.ok(metrics.measurementWindow.start && metrics.measurementWindow.end);
      assert.ok(fs.existsSync(path.join(root, run.id, "db-parameter-snapshot.json")));
      assert.ok(
        prometheus.samples.some(
          (sample) =>
            sample.metricName === "parkbench_openedge_db_parameter_snapshot_info" &&
            sample.labels.run_id === run.id &&
            sample.labels.display_value === "1000"
        )
      );
      assert.ok(
        orchestrator.calls.indexOf("stop-workload") < orchestrator.calls.indexOf("cleanup")
      );
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a wrong ingested value blocks workload and retains the original mismatch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-parameter-ingestion-"));
  const orchestrator = new FakeRunOrchestrator();
  class WrongValuePrometheus extends MemoryPrometheusClient {
    override async queryInstant(query: string) {
      const samples = await super.queryInstant(query);
      return query.startsWith("parkbench_openedge_db_parameter_snapshot_info")
        ? samples.map((sample) => ({
            ...sample,
            labels: { ...sample.labels, display_value: "stale-value" }
          }))
        : samples;
    }
  }
  const prometheus = new WrongValuePrometheus();
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
      orchestrator,
      prometheus,
      phaseScale: 0,
      parameterCapture: async () => ({
        contractVersion: "openedge-db-parameter-capture.v1",
        databaseName: "parkbench",
        attemptedAt: "2026-09-28T10:00:00.000Z",
        capturedAt: "2026-09-28T10:00:00.000Z",
        source: "_DbParams",
        status: "complete",
        rows: [{ name: "-B", rawValue: "500", dtype: 4, isDefault: false }]
      })
    }
  );
  try {
    const startup = {
      contractVersion: "db-startup-parameters.v1" as const,
      databaseName: "parkbench",
      startupFile: { status: "absent" as const },
      parameters: [
        {
          name: "-B",
          displayValue: "1000",
          source: "queued" as const,
          overrides: [],
          applicability: "database_broker" as const,
          verification: "pending" as const
        }
      ]
    };
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [
          { id: "v1", name: "Variant", parameters: { "-B": 1000 }, databaseStartup: startup }
        ],
        inputs: images
      },
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(run.failureCode, "database_parameter_unapplied");
    assert.match(run.failureReason ?? "", /observed=500/);
    assert.equal(orchestrator.calls.includes("start-workload"), false);
    assert.ok(fs.existsSync(path.join(root, run.id, "db-parameter-snapshot.json")));
    assert.ok(
      platform.repositories.listArtifacts(run.id).some((item) => item.kind === "diagnostics")
    );
    assert.equal(
      metricsReference(root, run.id, platform.repositories).measurementState,
      "not_started"
    );
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a snapshot missing from bounded Prometheus reads is reported when the run finalizes", async () => {
  for (const omitted of ["status", "info"] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-parameter-range-gap-"));
    const orchestrator = new FakeRunOrchestrator();
    class MissingRangePrometheus extends MemoryPrometheusClient {
      override async queryRawRange(
        query: string,
        start: number,
        end: number,
        step: number,
        options = {}
      ) {
        const samples = await super.queryRawRange(query, start, end, step, options);
        return samples.filter(
          (sample) => sample.metricName !== `parkbench_openedge_db_parameter_snapshot_${omitted}`
        );
      }
    }
    const prometheus = new MissingRangePrometheus();
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
        orchestrator,
        prometheus,
        phaseScale: 0,
        parameterCapture: async () => ({
          contractVersion: "openedge-db-parameter-capture.v1",
          databaseName: "parkbench",
          attemptedAt: "2026-09-28T10:00:00.000Z",
          capturedAt: "2026-09-28T10:00:00.000Z",
          source: "_DbParams",
          status: "complete",
          rows: [{ name: "-B", rawValue: "500", dtype: 4, isDefault: false }]
        })
      }
    );
    try {
      const startup = {
        contractVersion: "db-startup-parameters.v1" as const,
        databaseName: "parkbench",
        startupFile: { status: "absent" as const },
        parameters: [
          {
            name: "-B",
            displayValue: "1000",
            source: "queued" as const,
            overrides: [],
            applicability: "database_broker" as const,
            verification: "pending" as const
          }
        ]
      };
      const experiment = platform.coordinator.createExperiment(
        {
          scenario: { id: scenario.id, version: scenario.version },
          comparisonMode: "exploratory",
          repetitions: 1,
          variants: [
            { id: "v1", name: "Variant", parameters: { "-B": 1000 }, databaseStartup: startup }
          ],
          inputs: images
        },
        scenario as any
      );
      const run = await platform.coordinator.executeRun(
        platform.repositories.getRun(experiment.runIds[0])!
      );
      assert.equal(run.state, "FAILED");
      assert.equal(run.failureCode, "database_parameter_unapplied");
      assert.equal(orchestrator.calls.includes("start-workload"), false);
      assert.ok(fs.existsSync(path.join(root, run.id, "db-parameter-snapshot.json")));
      const diagnostics = platform.repositories
        .listArtifacts(run.id)
        .filter((item) => item.kind === "diagnostics")
        .map((item) => fs.readFileSync(path.join(root, item.path), "utf8"));
      assert.ok(
        diagnostics.some((item) =>
          item.includes(
            `run_metrics_required_sample_missing:parkbench_openedge_db_parameter_snapshot_${omitted}`
          )
        )
      );
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a snapshot series missing at finalization fails the run and keeps the startup checkpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-parameter-final-gap-"));
  const orchestrator = new FakeRunOrchestrator();
  // Instant reads (the startup ingestion check) see the series; the finalizer's bounded raw read does not.
  class FinalRangeGapPrometheus extends MemoryPrometheusClient {
    override async queryRawRange(
      query: string,
      start: number,
      end: number,
      step: number,
      options = {}
    ) {
      const samples = await super.queryRawRange(query, start, end, step, options);
      return samples.filter(
        (sample) => sample.metricName !== "parkbench_openedge_db_parameter_snapshot_info"
      );
    }
  }
  const prometheus = new FinalRangeGapPrometheus();
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
      orchestrator,
      prometheus,
      phaseScale: 0,
      parameterCapture: async () => ({
        contractVersion: "openedge-db-parameter-capture.v1",
        databaseName: "parkbench",
        attemptedAt: "2026-09-28T10:00:00.000Z",
        capturedAt: "2026-09-28T10:00:00.000Z",
        source: "_DbParams",
        status: "complete",
        rows: [{ name: "-B", rawValue: "1000", dtype: 4, isDefault: false }]
      })
    }
  );
  try {
    const startup = {
      contractVersion: "db-startup-parameters.v1" as const,
      databaseName: "parkbench",
      startupFile: { status: "absent" as const },
      parameters: [
        {
          name: "-B",
          displayValue: "1000",
          source: "queued" as const,
          overrides: [],
          applicability: "database_broker" as const,
          verification: "pending" as const
        }
      ]
    };
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [
          { id: "v1", name: "Variant", parameters: { "-B": 1000 }, databaseStartup: startup }
        ],
        inputs: images
      },
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(run.state, "FAILED");
    assert.equal(orchestrator.calls.includes("start-workload"), true);
    assert.equal(run.failureKind, "observer");
    assert.ok(fs.existsSync(path.join(root, run.id, "db-parameter-snapshot.json")));
    const diagnostics = platform.repositories
      .listArtifacts(run.id)
      .filter((item) => item.kind === "diagnostics")
      .map((item) => fs.readFileSync(path.join(root, item.path), "utf8"));
    assert.ok(
      diagnostics.some(
        (item) =>
          item.includes("run_metrics_unavailable") &&
          item.includes(
            "run_metrics_required_sample_missing:parkbench_openedge_db_parameter_snapshot_info"
          )
      )
    );
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
