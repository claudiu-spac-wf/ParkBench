import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import { verifyRequiredSources } from "../../packages/metrics/src/required-sources";
import { resolveDatabaseRunControls } from "../../packages/contracts/src/database-run-controls";
import type { Run } from "../../packages/contracts/src/run";
import type { MetricSample } from "../../packages/contracts/src/metrics";
import { summaryRun } from "../helpers/summary";

const start = Date.parse("2026-10-03T00:00:00Z") / 1000;
const window = {
  start: new Date(start * 1000).toISOString(),
  end: new Date((start + 10) * 1000).toISOString(),
  state: "completed" as const,
  durationSeconds: 10
};
const prefix = "parkbench_openedge_db_";
const tuples = [
  {
    latch_name: 'buffer"pool\\lock',
    latch_type: "shared",
    latch_id: "native-1",
    availability: "available"
  },
  {
    latch_name: "transaction",
    latch_type: "exclusive",
    latch_id: "native-2",
    availability: "available"
  },
  { latch_name: "idle", latch_type: "shared", latch_id: "native-3", availability: "available" }
];
function fixture() {
  const controls = resolveDatabaseRunControls();
  controls.requirements = { namedLatchRequired: true, observerProtocolVersion: 4 };
  const inventory = {
    runId: "named-finalize",
    database: "owned-db",
    databaseEpoch: "epoch-a",
    capturedAt: window.start,
    authoritativePublisher: "endpoint",
    complete: true,
    instances: structuredClone(tuples)
  };
  const run: Run = {
    ...summaryRun("named-finalize"),
    state: "FINALIZING",
    measurementValidity: "PENDING",
    cleanupStatus: "PENDING",
    startedAt: window.start,
    phaseBoundaries: { measurement: { startedAt: window.start, finishedAt: window.end } },
    environmentSnapshot: {
      scenario: { id: "named-fixture" },
      databaseRunControls: controls,
      namedLatchInventories: [inventory],
      metricsCollectionMode: "continuous",
      measurementWindow: { ...window },
      sourceCadences: { prometheusScrapeSeconds: 5, nativeDatabaseRefreshSeconds: 5 }
    }
  };
  const samples: MetricSample[] = [];
  for (const offset of [0, 5]) {
    const labels = {
      run_id: run.id,
      experiment_id: run.experimentId,
      variant_id: run.variantId,
      repetition: String(run.repetition),
      component: "observer",
      phase: "measurement" as const,
      database: "owned-db",
      database_epoch: "epoch-a",
      job: "parkbench-runs",
      service: "database"
    };
    const add = (
      name: string,
      value: number,
      dimensions: Record<string, string> = {},
      type: "gauge" | "counter" = "gauge"
    ) =>
      samples.push({
        metricName: prefix + name,
        labels: { ...labels, ...dimensions },
        timestamp: start + offset,
        value,
        type,
        source: "_Latch"
      });
    add("latch_inventory_complete", 1);
    add("latch_inventory_instances", tuples.length);
    for (const [index, tuple] of tuples.entries()) {
      const { availability: _availability, ...dimensions } = tuple;
      add("latch_inventory_info", 1, dimensions);
      add("latch_named_waits_total", index === 2 ? 0 : offset * (index + 1), dimensions, "counter");
      add("metric_available", 1, {
        ...dimensions,
        family: "latch",
        measurement: "latch_named_waits_total",
        reason: "available"
      });
      // Unsupported duration is optional, with matching tuple availability.
      add("metric_available", 0, {
        ...dimensions,
        family: "latch",
        measurement: "latch_named_wait_or_spin_duration_seconds_total",
        reason: "field_missing"
      });
    }
  }
  return { run, samples, inventory };
}
const namedGaps = (gaps: any[]) =>
  gaps.filter(
    (g) =>
      g.metricName?.startsWith(prefix + "latch_") || String(g.observerId).includes("named-latch")
  );

test("required latch verification accepts every measured tuple, including zero and unsupported optional duration", async () => {
  const { run, samples } = fixture();
  const result = await verifyRequiredSources(new MemoryPrometheusClient(samples), run, window, 5);
  assert.deepEqual(namedGaps(result.gaps), []);
  assert.ok(
    result.queries.some(
      (q) => q.metricName === prefix + "latch_named_waits_total" && q.labelKeys.includes("latch_id")
    )
  );
});

test("one finite wait or another tuple's availability cannot prove a complete named capture", async () => {
  for (const damage of [
    (f: ReturnType<typeof fixture>) => {
      delete f.run.environmentSnapshot!.namedLatchInventories;
    },
    (f: ReturnType<typeof fixture>) => {
      f.inventory.complete = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.samples = f.samples.filter(
        (s) =>
          !(s.metricName === prefix + "latch_inventory_info" && s.labels.latch_id === "native-2")
      );
    },
    (f: ReturnType<typeof fixture>) => {
      f.samples = f.samples.filter(
        (s) =>
          !(s.metricName === prefix + "latch_named_waits_total" && s.labels.latch_id === "native-2")
      );
    },
    (f: ReturnType<typeof fixture>) => {
      f.samples = f.samples.filter(
        (s) => !(s.metricName === prefix + "metric_available" && s.labels.latch_id === "native-2")
      );
    },
    (f: ReturnType<typeof fixture>) => {
      f.samples = f.samples.filter((s) => s.timestamp === start);
    },
    (f: ReturnType<typeof fixture>) => {
      for (const s of f.samples) s.labels.job = "parkbench-control-plane";
    },
    (f: ReturnType<typeof fixture>) => {
      for (const s of f.samples) s.labels.database_epoch = "foreign-epoch";
    }
  ]) {
    const f = fixture();
    damage(f);
    const result = await verifyRequiredSources(
      new MemoryPrometheusClient(f.samples),
      f.run,
      window,
      5
    );
    assert.ok(
      namedGaps(result.gaps).length,
      "missing tuple, coverage or owned inventory must be a named gap"
    );
  }
  const f = fixture();
  const result = await verifyRequiredSources(
    new MemoryPrometheusClient(f.samples, true),
    f.run,
    window,
    5
  );
  assert.ok(namedGaps(result.gaps).some((g) => g.availabilityReason === "source_unavailable"));
});

test("named failure is published after cleanup while generic gaps and earlier terminal causes retain their meanings", async () => {
  for (const state of ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "THRESHOLD_FAILED"] as const) {
    const f = fixture(),
      root = fs.mkdtempSync(path.join(os.tmpdir(), "named-finalization-"));
    f.samples = f.samples.filter(
      (s) =>
        !(s.metricName === prefix + "latch_named_waits_total" && s.labels.latch_id === "native-2")
    );
    if (state !== "SUCCEEDED") {
      f.run.failureKind =
        state === "THRESHOLD_FAILED"
          ? "threshold"
          : state === "FAILED"
          ? "infrastructure"
          : state === "CANCELLED"
            ? "cancellation"
            : "interruption";
      f.run.failureReason = "earlier primary reason";
    }
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
      { testMode: true, prometheus: new MemoryPrometheusClient(f.samples) }
    );
    let cleaned = false;
    try {
      const result = await platform.finalizer.finalize(f.run, {
        terminalState: state,
        start,
        end: start + 10,
        measurementState: "completed",
        cleanup() {
          assert.notEqual(platform.repositories.getSummaryCache(f.run.id)?.status, "READY");
          cleaned = true;
        }
      });
      assert.equal(cleaned, true);
      assert.equal(result.cleanupStatus, "COMPLETE");
      assert.equal(result.state, state === "SUCCEEDED" ? "FAILED" : state);
      assert.equal(result.measurementValidity, "UNAVAILABLE");
      assert.ok(namedGaps(result.completeness!.requiredGaps).length);
      if (state === "SUCCEEDED") {
        assert.equal(result.failureCode, "named_latch_evidence_missing");
        assert.equal(result.failureKind, "observer");
      } else assert.equal(result.failureReason, "earlier primary reason");
      const cache = platform.repositories.getSummaryCache(f.run.id);
      assert.equal(cache?.status, "READY");
      assert.equal(cache?.header?.run.state, result.state);
      assert.ok(
        platform.repositories.listArtifacts(f.run.id).some((a) => a.kind === "run_context")
      );
      assert.ok(fs.existsSync(path.join(root, f.run.id, "diagnostics.json")));
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("aggregate-only history and unrelated generic gaps do not acquire named requirements", async () => {
  const f = fixture();
  delete f.run.environmentSnapshot!.databaseRunControls;
  delete f.run.environmentSnapshot!.namedLatchInventories;
  const before = structuredClone(f.run);
  const result = await verifyRequiredSources(new MemoryPrometheusClient(), f.run, window, 5);
  assert.deepEqual(namedGaps(result.gaps), []);
  assert.equal(f.run.state, before.state);
  assert.ok(result.gaps.some((g) => g.observerId === "required-source:workload"));
});

test("later inventory changes remain scoped and every new instance needs matching evidence", async () => {
  const f = fixture();
  const extra = { latch_name: "buffer", latch_type: "shared", latch_id: "native-4" };
  const model = f.samples.find(
    (s) => s.metricName === prefix + "latch_inventory_info" && s.timestamp === start + 5
  )!;
  f.samples.push({ ...model, labels: { ...model.labels, ...extra } });
  f.samples.find(
    (s) => s.metricName === prefix + "latch_inventory_instances" && s.timestamp === start + 5
  )!.value = 4;
  const missing = await verifyRequiredSources(
    new MemoryPrometheusClient(f.samples),
    f.run,
    window,
    5
  );
  assert.ok(namedGaps(missing.gaps).some((g) => g.measurementId?.includes("native-4")));
  f.samples.push({
    ...model,
    metricName: prefix + "latch_named_waits_total",
    type: "counter",
    value: 0,
    labels: { ...model.labels, ...extra }
  });
  for (const [measurement, value, reason] of [
    ["latch_named_waits_total", 1, "available"],
    ["latch_named_wait_or_spin_duration_seconds_total", 0, "field_missing"]
  ] as const)
    f.samples.push({
      ...model,
      metricName: prefix + "metric_available",
      value,
      labels: { ...model.labels, ...extra, family: "latch", measurement, reason }
    });
  const result = await verifyRequiredSources(
    new MemoryPrometheusClient(f.samples),
    f.run,
    window,
    5
  );
  assert.deepEqual(namedGaps(result.gaps), []);
  const retained = f.run.environmentSnapshot!.namedLatchInventories as any[];
  assert.ok(retained.some((i) => i.instances.some((tuple: any) => tuple.latch_id === "native-4")));
  assert.equal(retained[0].instances.length, 3, "startup inventory stays immutable");
});

test("controller copies cannot override authoritative endpoint evidence or manufacture coverage", async () => {
  const f = fixture();
  const copies = f.samples.map((s) => ({
    ...s,
    value: s.metricName.endsWith("waits_total") ? 9999 : s.value,
    labels: { ...s.labels, job: "parkbench-control-plane" }
  }));
  const result = await verifyRequiredSources(
    new MemoryPrometheusClient([...f.samples, ...copies]),
    f.run,
    window,
    5
  );
  assert.deepEqual(namedGaps(result.gaps), []);
});
