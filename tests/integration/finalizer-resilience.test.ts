import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import { Run } from "../../packages/contracts/src/run";

describe("finalizer recovery record", () => {
  it("runs owned cleanup and writes diagnostics when SQLite writes fail", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-finalizer-recovery-"));
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
      { testMode: true, prometheus: new MemoryPrometheusClient() }
    );
    const run: Run = {
      id: "run-finalizer-recovery",
      experimentId: "exp-finalizer-recovery",
      variantId: "baseline",
      repetition: 1,
      state: "FINALIZING",
      measurementValidity: "PENDING",
      composeProject: "parkbench-run-finalizer-recovery",
      resourceNamespace: {},
      environmentSnapshot: {},
      cleanupStatus: "PENDING"
    };
    const broken = new Error("database disk image is malformed");
    (platform.repositories as any).saveRun = () => {
      throw broken;
    };
    (platform.repositories as any).saveEvent = () => {
      throw broken;
    };
    (platform.repositories as any).saveArtifact = () => {
      throw broken;
    };
    let cleaned = false;
    try {
      const result = await platform.finalizer.finalize(run, {
        terminalState: "FAILED",
        start: 0,
        end: 1,
        cleanup: async () => {
          cleaned = true;
        }
      });

      assert.equal(cleaned, true);
      assert.equal(result.cleanupStatus, "COMPLETE");
      assert.equal(result.phase, "failed");
      assert.equal(fs.existsSync(path.join(root, `${run.id}/diagnostics.json`)), true);
      const status = JSON.parse(
        fs.readFileSync(path.join(root, `${run.id}/finalization-status.json`), "utf8")
      );
      assert.equal(status.contractVersion, "run-finalization.v1");
      assert.equal(status.cleanupStatus, "COMPLETE");
      assert.ok(status.errors.some((entry: any) => entry.stage === "database_run_update_failed"));
      assert.ok(
        status.errors.some(
          (entry: any) => entry.stage === "diagnostics_artifact_registration_failed"
        )
      );
      assert.ok(status.errors.some((entry: any) => entry.stage === "summary_persistence_failed"));
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists a terminal phase after a successful export and cleanup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-finalizer-phase-"));
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
      { testMode: true, prometheus: new MemoryPrometheusClient() }
    );
    const run: Run = {
      id: "run-finalizer-phase",
      experimentId: "exp-finalizer-phase",
      variantId: "baseline",
      repetition: 1,
      state: "FINALIZING",
      phase: "finalizing",
      measurementValidity: "PENDING",
      composeProject: "parkbench-run-finalizer-phase",
      resourceNamespace: {},
      environmentSnapshot: {},
      cleanupStatus: "PENDING"
    };
    try {
      const result = await platform.finalizer.finalize(run, {
        terminalState: "SUCCEEDED",
        start: 0,
        end: 1,
        cleanup: async () => {}
      });
      assert.equal(result.state, "SUCCEEDED");
      assert.equal(result.cleanupStatus, "COMPLETE");
      assert.equal(result.phase, "succeeded");
      assert.equal(platform.repositories.getRun(run.id)?.phase, "succeeded");
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

it("publishes one terminal summary/context after cleanup without new generic reports", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finalizer-current-")),
    platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: root,
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true, prometheus: new MemoryPrometheusClient() }
    );
  const run: Run = {
    id: "run-current-summary",
    experimentId: "exp-current",
    variantId: "v",
    repetition: 1,
    state: "FINALIZING",
    measurementValidity: "PENDING",
    composeProject: "current",
    resourceNamespace: {},
    environmentSnapshot: { scenario: {}, deterministicLoadSeed: 42 },
    cleanupStatus: "PENDING"
  };
  let cleanupReady = false;
  try {
    const result = await platform.finalizer.finalize(run, {
      terminalState: "FAILED",
      start: 0,
      end: 1,
      cleanup: () => {
        assert.equal(platform.repositories.getSummaryCache(run.id)?.status, "RECOMPUTING");
        assert.equal(platform.repositories.pageSummaryRows(run.id).rows.length, 0);
        cleanupReady = true;
      }
    });
    assert.equal(cleanupReady, true);
    assert.equal(result.cleanupStatus, "COMPLETE");
    const cache = platform.repositories.getSummaryCache(run.id);
    assert.equal(cache?.status, "READY");
    assert.equal(cache?.header?.run.state, "FAILED");
    assert.equal(cache?.header?.quality.cleanupStatus, "COMPLETE");
    const artifacts = platform.repositories.listArtifacts(run.id);
    assert.equal(artifacts.filter((a) => a.kind === "run_comparison_summary").length, 1);
    assert.equal(artifacts.filter((a) => a.kind === "run_context").length, 1);
    assert.equal(
      artifacts.some((a) => ["load_summary", "observer_report", "run_evidence"].includes(a.kind)),
      false
    );
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const missing of [
  "",
  "parkbench_workload_requests_total",
  "parkbench_workload_request_duration_seconds_bucket",
  "parkbench_openedge_pas_requests_total",
  "node_memory_MemAvailable_bytes",
  "parkbench_openedge_db_database_table_operations_total",
  "parkbench_file_disk_usage_bytes"
]) {
  it(`verifies ${missing} in Prometheus with an empty scenario requirement list before cleanup`, async () => {
    const { MeasurementFixtureClient } = await import("../helpers/measurement-fixture");
    const { summaryRun } = await import("../helpers/summary");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "finalizer-required-"));
    const start = Date.parse("2026-09-30T00:00:00Z") / 1000;
    const client = new MeasurementFixtureClient("required-run", start, 1, 10);
    const base = client.queryRawRange.bind(client);
    client.queryRawRange = async (...args) =>
      args[0].startsWith(missing + "{") ? [] : base(...args);
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: root,
        prometheusUrl: "http://prometheus",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true, prometheus: client }
    );
    const run = summaryRun("required-run");
    run.state = "FINALIZING";
    run.measurementValidity = "PENDING";
    run.startedAt = new Date(start * 1000).toISOString();
    run.phaseBoundaries = {
      measurement: {
        startedAt: run.startedAt,
        finishedAt: new Date((start + 10) * 1000).toISOString()
      }
    };
    run.environmentSnapshot = {
      scenario: { target: { pasReplicas: 1 }, requiredMeasurements: [] },
      sourceCadences: { prometheusScrapeSeconds: 1 },
      observerHealth: { healthy: true }
    };
    platform.repositories.saveRun(run);
    let checkedBeforeCleanup = false;
    try {
      const result = await platform.finalizer.finalize(run, {
        terminalState: "SUCCEEDED",
        start,
        end: start + 10,
        cleanup: () => {
          checkedBeforeCleanup = true;
          assert.equal(
            run.completeness?.requiredGaps.some((g) => g.metricName === missing),
            !!missing
          );
        }
      });
      assert.ok(checkedBeforeCleanup);
      assert.equal(result.state, missing ? "INCOMPLETE" : "SUCCEEDED");
      assert.equal(result.failureKind, missing ? "observer" : undefined);
      assert.equal(result.cleanupStatus, "COMPLETE");
      const header = platform.repositories.getSummaryCache(run.id)?.header;
      assert.ok(header);
      assert.equal(header.quality.complete, !missing);
      assert.ok(
        header.metricsReference.queries.some(
          (q) =>
            (!missing || q.selector.startsWith(missing + "{")) &&
            q.purpose === "required_source_verification"
        )
      );
      assert.equal(
        header.quality.requiredGaps.some(
          (g) => g.metricName === missing && g.availabilityReason === "required_series_missing"
        ),
        !!missing
      );
      assert.equal(
        platform.repositories
          .listArtifacts(run.id)
          .filter((a) => a.kind === "run_comparison_summary").length,
        1
      );
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

it("marks an unresolved configured PAS member incomplete and preserves its unavailable detail", async () => {
  const { MeasurementFixtureClient } = await import("../helpers/measurement-fixture");
  const { summaryRun } = await import("../helpers/summary");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finalizer-member-"));
  const start = Date.parse("2026-09-30T00:00:00Z") / 1000;
  const client = new MeasurementFixtureClient("member-run", start, 1, 10, 2);
  const base = client.queryRawRange.bind(client);
  client.queryRawRange = async (...args) =>
    (await base(...args)).filter(
      (s) => s.metricName !== "container_start_time_seconds" || s.labels.service !== "pas-2"
    );
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://prometheus",
      prometheusRetention: "7d",
      openedge: {}
    },
    { testMode: true, prometheus: client }
  );
  const run = summaryRun("member-run");
  run.state = "FINALIZING";
  run.measurementValidity = "PENDING";
  run.phaseBoundaries = {
    measurement: {
      startedAt: new Date(start * 1000).toISOString(),
      finishedAt: new Date((start + 10) * 1000).toISOString()
    }
  };
  run.environmentSnapshot = {
    scenario: { target: { pasReplicas: 2 } },
    sourceCadences: { prometheusScrapeSeconds: 1 }
  };
  platform.repositories.saveRun(run);
  for (const resourceId of ["database", "pas-1", "pas-2"])
    platform.repositories.saveResource(run.id, {
      resourceId,
      resourceType: "container",
      labels: {},
      createdAt: run.phaseBoundaries.measurement!.startedAt!
    });
  try {
    const result = await platform.finalizer.finalize(run, {
      terminalState: "SUCCEEDED",
      start,
      end: start + 10,
      cleanup: () => {}
    });
    assert.equal(result.state, "INCOMPLETE");
    assert.ok(
      result.completeness?.requiredGaps.some(
        (g) => g.measurementId === "pas-2" && g.availabilityReason === "required_member_missing"
      )
    );
    const rows = platform.repositories.pageSummaryRows(run.id, { limit: 100 }).rows;
    const pas2 = rows.find(
      (r) => r.definitionId === "cpu.usage" && r.dimensions.replica === "pas-2"
    )!;
    assert.equal(pas2.statistics.average?.value, null);
    assert.ok(pas2.coverage.reasons.includes("required_member_missing"));
    assert.equal(
      rows.find((r) => r.group === "pas" && r.definitionId === "cpu.usage" && !r.dimensions.replica)
        ?.statistics.total?.status,
      "partial"
    );
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
