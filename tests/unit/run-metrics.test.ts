import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MetricSample } from "../../packages/contracts/src/metrics";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import {
  queryRunMeasurement,
  verifyRequiredRunSamples
} from "../../packages/metrics/src/run-metrics";

function sample(
  metricName: string,
  labels: Record<string, string>,
  timestamp: number,
  value = 1
): MetricSample {
  return { metricName, type: "gauge", labels: labels as any, timestamp, value, source: "fixture" };
}

describe("run metrics read back from Prometheus", () => {
  it("selects continuous sources by exact time windows while retaining historical phase labels", async () => {
    const client = new MemoryPrometheusClient([
      sample("node_memory_MemAvailable_bytes", { run_id: "continuous" }, 119),
      sample("node_memory_MemAvailable_bytes", { run_id: "continuous" }, 120),
      sample("node_memory_MemAvailable_bytes", { run_id: "continuous" }, 179),
      sample("node_memory_MemAvailable_bytes", { run_id: "continuous" }, 180),
      sample("legacy", { run_id: "continuous", phase: "warmup" }, 130),
      sample("legacy", { run_id: "continuous", phase: "measurement" }, 130)
    ]);
    const measured = await queryRunMeasurement(client, {
      runId: "continuous",
      start: 100,
      end: 200,
      measurementStart: 120,
      measurementEnd: 180,
      stepSeconds: 5
    });
    assert.deepEqual(
      measured.samples.map((s) => s.timestamp),
      [120, 130, 179]
    );
    assert.ok(measured.samples.every((s) => s.labels.phase === "measurement"));
  });
  it("reads only the measurement window at the scrape step and records where the series live", async () => {
    const queries: Array<{ query: string; start: number; end: number; step: number }> = [];
    class Recording extends MemoryPrometheusClient {
      override async queryRange(query: string, start: number, end: number, step: number) {
        queries.push({ query, start, end, step });
        return super.queryRange(query, start, end, step);
      }
    }
    const client = new Recording([
      sample("parkbench_workload_requests_total", { run_id: "run-1", phase: "warmup" }, 105),
      sample("parkbench_workload_requests_total", { run_id: "run-1", phase: "measurement" }, 130),
      sample("parkbench_workload_requests_total", { run_id: "run-2", phase: "measurement" }, 130),
      sample(
        "container_cpu_usage_seconds_total",
        { container_label_parkbench_run_id: "run-1", id: "/docker/run-1-database" },
        140
      ),
      sample("parkbench_workload_requests_total", { run_id: "run-1", phase: "measurement" }, 200)
    ]);
    const measured = await queryRunMeasurement(client, {
      runId: "run-1",
      start: 100,
      end: 190,
      measurementStart: 120,
      measurementEnd: 180,
      stepSeconds: 15
    });
    assert.deepEqual(
      queries.map(({ start, end, step }) => [start, end, step]),
      [
        [120, 180, 15],
        [120, 180, 15]
      ]
    );
    assert.equal(measured.samples.length, 2);
    assert.ok(measured.samples.every((item) => item.labels.phase === "measurement"));
    assert.equal(measured.expectedSamples, 5);
    assert.deepEqual(measured.reference.queries, [
      '{run_id="run-1"}',
      '{container_label_parkbench_run_id="run-1"}'
    ]);
    assert.equal(measured.reference.source, "prometheus");
    assert.equal(measured.reference.stepSeconds, 15);
    assert.deepEqual(measured.reference.runWindow, {
      start: new Date(100_000).toISOString(),
      end: new Date(190_000).toISOString()
    });
    assert.deepEqual(measured.reference.measurementWindow, {
      start: new Date(120_000).toISOString(),
      end: new Date(180_000).toISOString()
    });
    assert.equal(measured.reference.sampleCount, 2);
    assert.ok(measured.reference.labelKeys.includes("phase"));
  });

  it("reads nothing when measurement never started", async () => {
    const client = new MemoryPrometheusClient([
      sample("parkbench_workload_requests_total", { run_id: "run-1", phase: "measurement" }, 130)
    ]);
    const measured = await queryRunMeasurement(client, {
      runId: "run-1",
      start: 100,
      end: 190,
      measurementState: "not_started",
      stepSeconds: 15
    });
    assert.deepEqual(measured.samples, []);
    assert.equal(measured.expectedSamples, 0);
    assert.equal(measured.reference.measurementWindow, null);
  });

  it("verifies required samples are queryable and names the first missing one", async () => {
    const status = sample(
      "parkbench_openedge_db_parameter_snapshot_status",
      { run_id: "run-1", phase: "idle", state: "complete" },
      110
    );
    const info = sample(
      "parkbench_openedge_db_parameter_snapshot_info",
      { run_id: "run-1", phase: "idle", parameter: "-B", display_value: "1000" },
      110
    );
    const request = { runId: "run-1", start: 100, end: 190, stepSeconds: 15 };
    // Phase is not compared: the series is found whatever phase it was scraped in.
    await verifyRequiredRunSamples(
      new MemoryPrometheusClient([
        status,
        { ...info, labels: { ...info.labels, phase: "measurement" } }
      ]),
      request,
      [status, info]
    );
    await assert.rejects(
      () => verifyRequiredRunSamples(new MemoryPrometheusClient([status]), request, [status, info]),
      /run_metrics_required_sample_missing:parkbench_openedge_db_parameter_snapshot_info:-B/
    );
  });
});

describe("run summary input", () => {
  it("drops 0/1 flag series and keeps only identifying container labels", async () => {
    const { summaryInput } = await import("../../apps/control-plane/src/runs/finalizer");
    const container = sample(
      "container_cpu_usage_seconds_total",
      {
        phase: "measurement",
        name: "parkbench-run-1-pas-1-1",
        container_label_com_docker_compose_service: "pas-1",
        container_label_com_docker_compose_container_number: "1",
        container_label_com_docker_compose_config_hash: "abc",
        container_label_build_date: "2026-02-05"
      },
      130
    );
    const input = summaryInput([
      sample(
        "parkbench_openedge_db_metric_available",
        { run_id: "run-1", phase: "measurement" },
        130
      ),
      sample("node_filesystem_readonly", { run_id: "run-1", phase: "measurement" }, 130),
      sample("parkbench_workload_requests_total", { run_id: "run-1", phase: "measurement" }, 130),
      container
    ]);
    assert.deepEqual(
      input.map((item) => item.metricName),
      ["parkbench_workload_requests_total", "container_cpu_usage_seconds_total"]
    );
    assert.deepEqual(Object.keys(input[1].labels).sort(), [
      "container_label_com_docker_compose_container_number",
      "container_label_com_docker_compose_service",
      "name",
      "phase"
    ]);
  });
});

it("deduplicates overlapping selectors and filters actual phase/end boundaries", async () => {
  const both = sample(
    "container_memory_working_set_bytes",
    { run_id: "run-1", container_label_parkbench_run_id: "run-1", phase: "measurement", id: "abc" },
    130
  );
  const r = await queryRunMeasurement(
    new MemoryPrometheusClient([
      both,
      { ...both, timestamp: 180 },
      { ...both, timestamp: 140, labels: { ...both.labels, phase: "cooldown" } }
    ]),
    {
      runId: "run-1",
      start: 100,
      end: 200,
      measurementStart: 120,
      measurementEnd: 180,
      stepSeconds: 15
    }
  );
  assert.equal(r.samples.length, 1);
});
