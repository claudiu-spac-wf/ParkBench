import test from "node:test";
import assert from "node:assert/strict";
import {
  HttpPrometheusClient,
  MemoryPrometheusClient
} from "../../packages/metrics/src/prometheus-client";
import { verifyRequiredRunSamples } from "../../packages/metrics/src/run-metrics";
import { RunCoordinator } from "../../apps/control-plane/src/runs/coordinator";
import { summaryRun } from "../helpers/summary";
import { calculateCompleteness, DISK_IO_QUERIES } from "../../packages/metrics/src";

test("disk coverage retains 59 raw acquisitions and rejects a real internal gap", async () => {
  const run = summaryRun("disk-window");
  run.phaseBoundaries = {
    measurement: {
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(300250).toISOString()
    }
  };
  const samples: any[] = [];
  for (const metricName of [
    DISK_IO_QUERIES.containerRead,
    DISK_IO_QUERIES.containerWrite,
    DISK_IO_QUERIES.containerReadOperations,
    DISK_IO_QUERIES.containerWriteOperations
  ])
    for (let i = 0; i < 59; i++)
      samples.push({
        metricName,
        type: "counter",
        timestamp: 5.1 + i * 5,
        value: i,
        source: "cadvisor",
        labels: {
          id: "/docker/database",
          service: "database",
          job: "parkbench-run-owned-cadvisor",
          run_id: run.id
        }
      });
  const collect = async (values: any[]) =>
    (
      await (RunCoordinator.prototype as any).collectDiskIoCompleteness.call(
        {
          options: {
            phaseScale: 1,
            observerSamplingIntervalSeconds: 5,
            cadvisorHousekeepingSeconds: 1
          },
          prometheus: new MemoryPrometheusClient(values)
        },
        run,
        300,
        { resources: [{ name: "database", type: "container" }] }
      )
    ).filter((c: any) => c.observerId.startsWith("disk-io-cadvisor-"));
  const complete = await collect(samples);
  assert.equal(complete.length, 4);
  assert.ok(
    complete.every(
      (c: any) =>
        c.expected === 60 &&
        c.observed === 59 &&
        c.coverage.missingSeconds === 0 &&
        c.coverage.estimatedEdgeSeconds > 10
    )
  );
  assert.equal(calculateCompleteness(complete).complete, true);
  const missing = await collect(samples.filter((s) => s.timestamp !== 155.1));
  assert.equal(calculateCompleteness(missing).complete, false);
  assert.ok(missing.every((c: any) => c.coverage.missingSeconds >= 9.999));
  assert.equal(calculateCompleteness(await collect([])).complete, false);
});

test("all HTTP verification reads share the two-request budget and bounded windows", async () => {
  const original = globalThis.fetch;
  let active = 0,
    peak = 0;
  const windows: number[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("query")!;
    windows.push(
      url.pathname.endsWith("query_range")
        ? Number(url.searchParams.get("end")) - Number(url.searchParams.get("start"))
        : Number(query.match(/\[(\d+)ms\]$/)?.[1]) / 1000
    );
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(
        JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } })
      );
    } finally {
      active--;
    }
  };
  try {
    const client = new HttpPrometheusClient("http://prometheus");
    await Promise.all(
      Array.from({ length: 9 }, () => client.queryRange("node_disk_read_bytes_total", 0, 1200, 1))
    );
    assert.ok(peak <= 2, `peak=${peak}`);
    assert.ok(windows.every((n) => n <= 301.01));
  } finally {
    globalThis.fetch = original;
  }
});

test("startup verification streams chunks and discards them rather than using a full range read", async () => {
  const calls: Array<[number, number]> = [];
  const expected: any = {
    metricName: "parkbench_openedge_db_parameter_snapshot_info",
    labels: { run_id: "r", parameter: "-B", phase: "idle" },
    timestamp: 650,
    value: 1,
    type: "gauge",
    source: "parameters"
  };
  const client = new MemoryPrometheusClient([expected]);
  client.queryRange = async () => {
    throw new Error("unbounded_range_used");
  };
  const raw = client.queryRawRange.bind(client);
  client.queryRawRange = async (...args) => {
    calls.push([args[1], args[2]]);
    return raw(...args);
  };
  await verifyRequiredRunSamples(client, { runId: "r", start: 0, end: 1200, stepSeconds: 1 }, [
    expected
  ]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([a, b]) => b - a <= 301.01));
});

test("disk completeness streams bounded selectors without a nine-request fan-out", async () => {
  const client = new MemoryPrometheusClient();
  let active = 0,
    peak = 0;
  const calls: Array<[number, number]> = [];
  client.queryRange = async () => {
    throw new Error("unbounded_range_used");
  };
  client.queryRawRange = async (_selector, a, b) => {
    calls.push([a, b]);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return [];
    } finally {
      active--;
    }
  };
  const run = summaryRun("r");
  run.phaseBoundaries = {
    measurement: {
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1200000).toISOString()
    }
  };
  const counts = await (RunCoordinator.prototype as any).collectDiskIoCompleteness.call(
    { options: { phaseScale: 1, observerSamplingIntervalSeconds: 1 }, prometheus: client },
    run,
    1200,
    { resources: [{ name: "database", type: "container" }] }
  );
  assert.ok(peak <= 2);
  assert.ok(calls.length >= 36);
  assert.ok(calls.every(([a, b]) => b - a <= 301.01));
  assert.equal(counts.length, 9);
  assert.ok(counts.every((c: any) => c.observed === 0 && c.required));
});

test("oversized range responses split adaptively and irreducible batches fail explicitly", async () => {
  const original = globalThis.fetch;
  const tooMany = Array.from({ length: 100001 }, (_, i) => [i, "1"]);
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    const url = new URL(String(input));
    const start = Number(url.searchParams.get("start")),
      end = Number(url.searchParams.get("end"));
    const values = end - start > 150 || end - start <= 1 ? tooMany : [[start, "1"]];
    return new Response(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: [{ metric: { __name__: "node_disk_read_bytes_total" }, values }]
        }
      })
    );
  };
  try {
    const client = new HttpPrometheusClient("http://prometheus");
    const samples = await client.queryRange("node_disk_read_bytes_total", 0, 300, 1);
    assert.equal(samples.length, 2);
    assert.equal(calls, 3);
    await assert.rejects(
      () => client.queryRange("node_disk_read_bytes_total", 0, 1, 1),
      /summary_limit_exceeded:raw_samples/
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("scenario requirements use Prometheus only and preserve explicit native unavailability", async () => {
  const run = summaryRun("r");
  run.phaseBoundaries = {
    measurement: { startedAt: new Date(0).toISOString(), finishedAt: new Date(10000).toISOString() }
  };
  const metric = "parkbench_openedge_db_buffer_pool_logical_reads_total";
  const sample: any = {
    metricName: "parkbench_openedge_db_metric_available",
    value: 0,
    timestamp: 5,
    labels: {
      run_id: "r",
      experiment_id: run.experimentId,
      phase: "measurement",
      measurement: "buffer_pool_logical_reads_total",
      pool: "alternate",
      reason: "alternate_pool_disabled"
    },
    source: "fixture",
    type: "gauge"
  };
  const client = new MemoryPrometheusClient([sample]);
  client.queryRange = async () => {
    throw new Error("unbounded_range_used");
  };
  const stub = {
    prometheus: client,
    options: {
      observerSamplingIntervalSeconds: 1,
      observerMetrics: {
        samples: () => [{ ...sample, metricName: "parkbench_workload_requests_total", value: 10 }]
      }
    }
  };
  const gaps = await (RunCoordinator.prototype as any).collectRequiredMeasurementGaps.call(
    stub,
    run,
    {
      requiredMeasurements: [
        { id: "workload", metricName: "parkbench_workload_requests_total", source: "workload" },
        { id: "alternate", metricName: metric, source: "database" }
      ]
    }
  );
  assert.equal(gaps.length, 2);
  assert.equal(
    gaps.find((g: any) => g.measurementId === "workload")?.availabilityReason,
    "required_series_missing"
  );
  assert.equal(
    gaps.find((g: any) => g.measurementId === "alternate")?.availability,
    "not_configured"
  );
  assert.equal(
    gaps.find((g: any) => g.measurementId === "alternate")?.availabilityReason,
    "alternate_pool_disabled"
  );
});
