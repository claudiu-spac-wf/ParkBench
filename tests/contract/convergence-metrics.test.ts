import { buildComparison } from "../../apps/control-plane/src/comparisons/service";
import { summaryHeader, summaryRow, summaryRun } from "../helpers/summary";
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  MemoryPrometheusClient,
  PrometheusMetricBuffer,
  calculateRequiredMeasurementGaps,
  counterDelta,
  filterCAdvisorMetrics,
  parsePrometheusResponse,
  summarize,
  verifyDiskIoSources
} from "../../packages/metrics/src";
import { sampleToMetrics } from "../../packages/observers/src";
import scenario from "../../examples/scenarios/crud-rest.json";
import { comparison } from "../../apps/control-plane/src/comparisons/service";
import { generateRunCompose } from "../../packages/compose-runner/src";

describe("convergence metrics", () => {
  it("reports metric-specific gaps for declared required measurements", () => {
    const gaps = calculateRequiredMeasurementGaps(
      [
        { id: "workload", metricName: "parkbench_workload_requests_total", source: "workload" },
        { id: "database", metricName: "parkbench_openedge_db_dbstatus", source: "database" }
      ],
      [
        {
          metricName: "parkbench_workload_requests_total",
          labels: { phase: "measurement" } as any,
          timestamp: 1,
          value: 1,
          source: "loadgen"
        }
      ]
    );
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].measurementId, "database");
    assert.equal(gaps[0].metricName, "parkbench_openedge_db_dbstatus");
  });

  it("normalizes exporter disk metrics and retains run labels", () => {
    const samples = parsePrometheusResponse({
      data: {
        result: [
          {
            metric: {
              __name__: "container_fs_reads_bytes_total",
              container_label_parkbench_run_id: "run-1",
              container_label_parkbench_experiment_id: "exp-1",
              container_label_parkbench_variant_id: "baseline",
              container_label_parkbench_repetition: "1",
              container_label_parkbench_component: "container",
              service: "database",
              phase: "measurement"
            },
            values: [[100, "42"]]
          }
        ]
      }
    });
    assert.equal(samples[0].metricName, "parkbench_container_disk_read_bytes_total");
    assert.equal(samples[0].source, "cadvisor");
    assert.equal(samples[0].type, "counter");
    assert.equal(samples[0].labels.run_id, "run-1");
    assert.equal(samples[0].value, 42);
  });

  it("uses the monitored Compose service for cAdvisor series", () => {
    const [sample] = parsePrometheusResponse({
      data: {
        result: [
          {
            metric: {
              __name__: "container_fs_writes_bytes_total",
              service: "cadvisor",
              container_label_com_docker_compose_service: "database",
              container_label_parkbench_component: "database",
              container_label_parkbench_run_id: "run-1",
              phase: "measurement"
            },
            values: [[100, "7"]]
          }
        ]
      }
    });
    assert.equal(sample.labels.service, "database");
    assert.equal(sample.labels.component, "database");
  });

  it("scopes cAdvisor exposition to the active run and preserves ownership labels", () => {
    const body = [
      "# HELP container_fs_reads_bytes_total bytes",
      'container_fs_reads_bytes_total{container_label_parkbench_managed="true",container_label_parkbench_run_id="run-a",container_label_parkbench_experiment_id="exp-a",container_label_parkbench_variant_id="baseline",container_label_parkbench_repetition="1",container_label_parkbench_component="database",container_label_com_docker_compose_service="database"} 10',
      'container_fs_reads_bytes_total{container_label_parkbench_managed="true",container_label_parkbench_run_id="run-b",container_label_parkbench_experiment_id="exp-b"} 20',
      'container_fs_reads_bytes_total{container_label_parkbench_managed="false",container_label_parkbench_run_id="run-a"} 30'
    ].join("\n");
    const scoped = filterCAdvisorMetrics(body, "run-a");
    assert.match(scoped, /run-a/);
    assert.doesNotMatch(scoped, /run-b/);
    assert.doesNotMatch(scoped, /30$/m);
    assert.equal(filterCAdvisorMetrics(body), "\n");
    const buffer = new PrometheusMetricBuffer();
    buffer.append([
      {
        metricName: "parkbench_observer_health",
        type: "gauge",
        labels: {
          experiment_id: "exp-a",
          run_id: "run-a",
          variant_id: "baseline",
          repetition: "1",
          component: "observer",
          service: "custom-observer",
          phase: "measurement"
        },
        timestamp: 100,
        value: 1,
        source: "observer-runtime"
      }
    ]);
    assert.match(buffer.render(), /source="observer-runtime"/);
    assert.match(buffer.render(), /run_id="run-a"/);
  });

  it("fails source preflight when either disk source is missing", async () => {
    const client = new MemoryPrometheusClient([
      {
        metricName: "parkbench_container_disk_read_bytes_total",
        labels: { run_id: "run-1" } as any,
        timestamp: Date.now() / 1000,
        value: 1,
        source: "cadvisor"
      }
    ]);
    await assert.rejects(() => verifyDiskIoSources(client), /required_disk_io_source_unavailable/);
  });

  it("requires both read and write series from each disk source", async () => {
    const sourceSamples = [
      ["parkbench_container_disk_read_bytes_total", "cadvisor"],
      ["parkbench_container_disk_write_bytes_total", "cadvisor"],
      ["parkbench_container_disk_read_operations_total", "cadvisor"],
      ["parkbench_container_disk_write_operations_total", "cadvisor"],
      ["parkbench_container_disk_io_time_seconds_total", "cadvisor"],
      ["parkbench_host_disk_read_bytes_total", "node-exporter:block-device"],
      ["parkbench_host_disk_write_bytes_total", "node-exporter:block-device"],
      ["parkbench_host_disk_read_operations_total", "node-exporter:block-device"],
      ["parkbench_host_disk_write_operations_total", "node-exporter:block-device"],
      ["parkbench_host_disk_io_time_seconds_total", "node-exporter:block-device"]
    ].map(([metricName, source]) => ({
      metricName,
      labels: { run_id: "run-1" } as any,
      timestamp: Date.now() / 1000,
      value: 1,
      source
    }));
    assert.deepEqual(await verifyDiskIoSources(new MemoryPrometheusClient(sourceSamples)), {
      cadvisor: true,
      nodeExporterBlockDevice: true
    });
  });

  it("does not emit a zero file size for a directory", () => {
    const samples = sampleToMetrics(
      { path: "/tmp/dir", exists: true, diskUsageBytes: 10 },
      { runId: "r", experimentId: "e", variantId: "v", repetition: 1, phase: "measurement" }
    );
    assert.deepEqual(
      samples.map((sample) => sample.metricName),
      ["parkbench_file_disk_usage_bytes"]
    );
  });

  it("converts cumulative counters to interval deltas, including resets", () => {
    const samples = [0, 5, 2, 9].map((value, index) => ({
      metricName: "parkbench_workload_requests_total",
      type: "counter" as const,
      labels: {
        experiment_id: "e",
        run_id: "r",
        variant_id: "v",
        repetition: "1",
        component: "loadgen",
        service: "loadgen",
        phase: "measurement" as const
      },
      timestamp: index,
      value,
      source: "loadgen"
    }));
    assert.equal(counterDelta(samples), 14);
    assert.equal(summarize(samples, "r")[0].sum, 14);
  });

  it("decodes histogram buckets, count, and sum into percentile summaries", () => {
    const labels = {
      experiment_id: "e",
      run_id: "r",
      variant_id: "v",
      repetition: "1",
      component: "loadgen",
      service: "loadgen",
      phase: "measurement" as const,
      operation: "read"
    };
    const histogramSamples = [
      ["parkbench_workload_request_duration_seconds_bucket", "0.1", 1, 2],
      ["parkbench_workload_request_duration_seconds_bucket", "1", 2, 4],
      ["parkbench_workload_request_duration_seconds_bucket", "10", 2, 4],
      ["parkbench_workload_request_duration_seconds_bucket", "+Inf", 2, 4],
      ["parkbench_workload_request_duration_seconds_count", undefined, 2, 4],
      ["parkbench_workload_request_duration_seconds_sum", undefined, 0.2, 0.6]
    ].flatMap(([metricName, le, first, second]) =>
      [
        { metricName, le, value: first, timestamp: 1 },
        { metricName, le, value: second, timestamp: 2 }
      ].map((sample) => ({
        metricName: sample.metricName,
        type: "histogram" as const,
        labels: le === undefined ? labels : { ...labels, le },
        timestamp: sample.timestamp,
        value: sample.value,
        source: "loadgen"
      }))
    );
    const summaries = summarize(histogramSamples as any, "r", 2);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].type, "histogram");
    assert.equal(summaries[0].count, 2);
    assert.ok(Math.abs((summaries[0].sum ?? 0) - 0.4) < 1e-9);
    assert.ok(Math.abs((summaries[0].mean ?? 0) - 0.2) < 1e-9);
    assert.equal(summaries[0].p50, 0.1);
    assert.ok((summaries[0].p95 ?? 0) > 0.1);
    assert.equal(summaries[0].completeness, 1);
  });

  it("renders run targets on the shared metrics network and keeps service labels separate", () => {
    const bundle = generateRunCompose(
      "run-1",
      "exp-1",
      { ...scenario, target: { ...scenario.target, pasReplicas: 2 } } as any,
      {
        db: "db:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        pas: "pas:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      },
      {
        loadgenImage: "parkbench/loadgen:fixture",
        observerImage: "parkbench/observer:fixture"
      }
    );
    assert.match(bundle.file, /run-metrics:\n    external: true/);
    assert.match(bundle.file, /PARKBENCH_OBSERVER_KIND: "openedge_db_v1"/);
    assert.match(
      bundle.file,
      /PARKBENCH_OBSERVER_TARGET_URLS: "http:\/\/pas-1:8810,http:\/\/pas-2:8810"/
    );
    assert.match(
      bundle.file,
      /run-metrics:\n        aliases:\n          - parkbench-run-1-db-observer/
    );
  });

  it("returns saved baseline-relative values while incomplete runs remain inspectable", () => {
    const rows: any = { b: summaryRow(), v: summaryRow(), i: summaryRow() };
    rows.v.statistics.average.value = 1.5;
    const headers: any = { b: summaryHeader("b"), v: summaryHeader("v"), i: summaryHeader("i") };
    headers.i.run.state = "INCOMPLETE";
    headers.i.run.measurementValidity = "INCOMPLETE";
    headers.i.quality.complete = false;
    const reader: any = {
      read: (id: string) => ({ status: "READY", header: headers[id], attemptToken: id }),
      page: (id: string, opts: any) => ({
        rows: opts.tablesOnly ? [] : [rows[id]],
        hasMore: false,
        totalRowCount: opts.tablesOnly ? 0 : 1
      }),
      find: (id: string, key: string) => (rows[id].rowKey === key ? rows[id] : undefined),
      iterate: async function* (id: string) {
        yield rows[id];
      }
    };
    const result = buildComparison(
      {
        id: "saved",
        baselineRunId: "b",
        variantRunIds: ["v", "i"],
        selectionRevision: 1,
        createdAt: "now"
      },
      reader,
      (id) => ({
        ...summaryRun(id),
        state: headers[id].run.state,
        measurementValidity: headers[id].run.measurementValidity
      })
    );
    assert.equal(result.runs.length, 3);
    assert.equal(result.runs[1].rows[0].differences.average.absoluteDifference, 0.5);
    assert.equal(result.runs[2].rows[0].differences.average.absoluteDifference, 0);
    assert.equal(result.runs[2].measurementValidity, "INCOMPLETE");
    assert.equal(result.runs[2].rows[0].row.statistics.average.value, 1);
  });
});
