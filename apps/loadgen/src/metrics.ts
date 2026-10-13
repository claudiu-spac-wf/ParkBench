import { MetricSample, MetricType } from "../../../packages/contracts/src/metrics";
import type { RequestResult } from "./http-client";
import http from "node:http";

export const LOADGEN_LATENCY_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

export class OperationMetricAccumulator {
  private requests = 0;
  private errors = 0;
  private timeouts = 0;
  private latencyCount = 0;
  private latencySumSeconds = 0;
  private readonly latencyBuckets = LOADGEN_LATENCY_BUCKETS.map(() => 0);

  record(result: Pick<RequestResult, "operation" | "durationSeconds" | "error" | "timeout" | "latencyObservation">): void {
    this.requests += 1;
    if (result.error) this.errors += 1;
    if (result.timeout) this.timeouts += 1;
    if (result.latencyObservation === "lower_bound" ||
        !Number.isFinite(result.durationSeconds) || result.durationSeconds < 0) return;
    this.latencyCount += 1;
    this.latencySumSeconds += result.durationSeconds;
    LOADGEN_LATENCY_BUCKETS.forEach((limit, index) => {
      if (result.durationSeconds <= limit) this.latencyBuckets[index] += 1;
    });
  }

  snapshot() {
    return {
      requests: this.requests,
      errors: this.errors,
      timeoutCount: this.timeouts,
      latencySeconds: this.latencyCount ? this.latencySumSeconds / this.latencyCount : 0,
      latencyCount: this.latencyCount,
      latencySumSeconds: this.latencySumSeconds,
      latencyBuckets: [...this.latencyBuckets]
    };
  }
}

export function loadgenMetrics(input: {
  labels: Record<string, string>;
  requests: number;
  errors: number;
  inFlight: number;
  latencySeconds: number;
  phase: string;
  operation: string;
  timeoutCount?: number;
  throughputPerSecond?: number;
  latencies?: number[];
  latencyCount?: number;
  latencySumSeconds?: number;
  latencyBuckets?: number[];
}): MetricSample[] {
  const base: any = {
    labels: {
      ...input.labels,
      component: "loadgen",
      service: "loadgen",
      phase: input.phase,
      operation: input.operation
    },
    timestamp: Date.now() / 1000,
    source: "loadgen"
  };
  const latencies = input.latencies?.filter((value) => Number.isFinite(value) && value >= 0);
  const latencyCount = input.latencyCount ?? (latencies === undefined ? input.requests : latencies.length);
  const latencySumSeconds = input.latencySumSeconds ??
    (latencies !== undefined ? latencies.reduce((total, value) => total + value, 0)
      : input.latencySeconds * input.requests);
  const bucketCounts = input.latencyBuckets ?? LOADGEN_LATENCY_BUCKETS.map((limit) =>
    latencies !== undefined ? latencies.filter((value) => value <= limit).length
      : input.latencySeconds <= limit ? input.requests : 0);
  const histogram: MetricSample[] = [
    ...LOADGEN_LATENCY_BUCKETS.map((le, index) => ({
      ...base,
      metricName: "parkbench_workload_request_duration_seconds",
      type: "histogram" as const,
      labels: { ...base.labels, le: String(le) },
      value: bucketCounts[index]
    })),
    {
      ...base,
      metricName: "parkbench_workload_request_duration_seconds",
      type: "histogram" as const,
      labels: { ...base.labels, le: "+Inf" },
      value: latencyCount
    }
  ];
  return [
    {
      ...base,
      metricName: "parkbench_workload_requests_total",
      type: "counter",
      value: input.requests
    },
    {
      ...base,
      metricName: "parkbench_workload_errors_total",
      type: "counter",
      value: input.errors
    },
    { ...base, metricName: "parkbench_container_health", type: "gauge", value: 1 },
    ...histogram,
    { ...base, metricName: "parkbench_workload_in_flight", type: "gauge", value: input.inFlight },
    {
      ...base,
      metricName: "parkbench_workload_timeouts_total",
      type: "counter",
      value: input.timeoutCount ?? 0
    },
    {
      ...base,
      metricName: "parkbench_workload_throughput_per_second",
      type: "gauge",
      value: input.throughputPerSecond ?? 0
    },
    { ...base, metricName: "parkbench_workload_worker_health", type: "gauge", value: 1 },
    {
      ...base,
      metricName: "parkbench_workload_request_duration_seconds_count",
      type: "counter",
      value: latencyCount
    },
    {
      ...base,
      metricName: "parkbench_workload_request_duration_seconds_sum",
      type: "counter",
      value: latencySumSeconds
    }
  ];
}
export function prometheusText(samples: MetricSample[]): string {
  const lines: string[] = [];
  const types = new Map<string, MetricType>();
  for (const sample of samples) {
    const base = histogramBase(sample.metricName);
    types.set(
      base,
      sample.type === "histogram"
        ? "histogram"
        : (types.get(base) ?? sample.type ?? metricType(sample))
    );
  }
  for (const [metricName, type] of types) lines.push(`# TYPE ${metricName} ${type}`);
  lines.push(
    ...samples.flatMap((sample) => {
      const labels = Object.entries(sample.labels)
        .map(([key, value]) => `${key}="${escapeLabel(value ?? "")}"`)
        .join(",");
      if (sample.type === "histogram")
        return [
          `${histogramBase(sample.metricName)}_bucket{${labels}} ${sample.value} ${Math.floor(sample.timestamp * 1000)}`
        ];
      return [
        `${sample.metricName}{${labels}} ${sample.value} ${Math.floor(sample.timestamp * 1000)}`
      ];
    })
  );
  return `${lines.join("\n")}\n`;
}

export function metricSeriesKey(sample: MetricSample): string {
  return `${sample.metricName}|${JSON.stringify(sample.labels)}`;
}

function metricType(sample: MetricSample): MetricType {
  if (sample.type) return sample.type;
  return sample.metricName.endsWith("_total") ? "counter" : "gauge";
}

function histogramBase(metricName: string): string {
  if (metricName.endsWith("_count")) return metricName.slice(0, -6);
  if (metricName.endsWith("_sum")) return metricName.slice(0, -4);
  return metricName;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export function startMetricsServer(
  getSamples: () => MetricSample[],
  port = Number(process.env.PARKBENCH_METRICS_PORT ?? 0)
): Promise<{ close(): Promise<void> }> {
  const server = http.createServer((_request: any, response: any) => {
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain; version=0.0.4");
    response.end(prometheusText(getSamples()));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () =>
      resolve({
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    );
  });
}
