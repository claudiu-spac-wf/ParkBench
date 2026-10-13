import { accountResourceSamples } from "./resource-accounting";
import { MetricSample } from "../../contracts/src/metrics";
import { PrometheusClient } from "./prometheus-client";
import { readRawChunks, RawQueryOptions } from "./raw-query";

/**
 * Run time series stay in Prometheus (constitution 4.0.0, Principle II). A run reads back only
 * its measurement window at the scrape step, which is enough for summaries and evidence, and
 * records the queries and windows that locate the full series.
 */
export interface RunMetricsRequest {
  runId: string;
  /** Run window, in epoch seconds. */
  start: number;
  end: number;
  measurementState?: "not_started" | "completed" | "interrupted";
  measurementStart?: number | null;
  measurementEnd?: number | null;
  /** Prometheus scrape interval, in seconds. */
  stepSeconds: number;
}

export interface RunMetricsReference {
  contractVersion: "run-metrics-reference.v1";
  source: "prometheus";
  /** Selectors that return every series of the run over the run window. */
  queries: string[];
  runWindow: { start: string; end: string };
  measurementState: "not_started" | "completed" | "interrupted";
  measurementWindow: { start: string; end: string } | null;
  stepSeconds: number;
  /** Samples read back for the measurement window (not the full series). */
  sampleCount: number;
  sources: string[];
  labelKeys: string[];
}

export interface RunMeasurementMetrics {
  samples: MetricSample[];
  accountingGaps?: import("./resource-accounting").AccountingGap[];
  /** Number of steps in the measurement window, the expected samples per series. */
  expectedSamples: number;
  reference: RunMetricsReference;
}

export function runMetricsQueries(runId: string): string[] {
  const id = escapeLabelValue(runId);
  return [`{run_id="${id}"}`, `{container_label_parkbench_run_id="${id}"}`];
}

export async function queryRunMeasurement(
  client: PrometheusClient,
  request: RunMetricsRequest
): Promise<RunMeasurementMetrics> {
  const step = Math.max(1, Math.round(request.stepSeconds));
  const measurementState = request.measurementState ?? "completed";
  const window =
    measurementState === "not_started"
      ? null
      : {
          start: request.measurementStart ?? request.start,
          end: request.measurementEnd ?? request.end
        };
  const id = escapeLabelValue(request.runId);
  const samples: MetricSample[] = [];
  if (window) {
    const [run, containers] = await Promise.all([
      client.queryRange(`{run_id="${id}"}`, window.start, window.end, step),
      client.queryRange(
        `{container_label_parkbench_run_id="${id}"}`,
        window.start,
        window.end,
        step
      )
    ]);
    samples.push(
      ...run
        .filter((sample) => !sample.labels.phase || sample.labels.phase === "measurement")
        .map((sample) => ({
          ...sample,
          labels: { ...sample.labels, phase: "measurement" as const }
        }))
    );
    // Container series from cAdvisor carry no phase label; inside the window they are measurement.
    for (const sample of containers)
      samples.push(
        sample.labels.phase
          ? sample
          : { ...sample, labels: { ...sample.labels, phase: "measurement" as const } }
      );
  }
  const sources = new Set<string>();
  const labelKeys = new Set<string>();
  for (const sample of samples) {
    sources.add(sample.source);
    for (const key of Object.keys(sample.labels)) labelKeys.add(key);
  }
  return {
    samples: accountResourceSamples(
      samples.filter(
        (s) =>
          !window ||
          (s.timestamp >= window.start &&
            s.timestamp < window.end &&
            s.labels.phase === "measurement")
      )
    ).samples,
    accountingGaps: accountResourceSamples(samples).gaps,
    expectedSamples: window ? Math.max(1, Math.floor((window.end - window.start) / step) + 1) : 0,
    reference: {
      contractVersion: "run-metrics-reference.v1",
      source: "prometheus",
      queries: runMetricsQueries(request.runId),
      runWindow: { start: isoSeconds(request.start), end: isoSeconds(request.end) },
      measurementState,
      measurementWindow: window
        ? { start: isoSeconds(window.start), end: isoSeconds(window.end) }
        : null,
      stepSeconds: step,
      sampleCount: samples.length,
      sources: [...sources].sort(),
      labelKeys: [...labelKeys].sort()
    }
  };
}

/**
 * Checks that each required sample (for example the database parameter snapshot) is in
 * Prometheus for the run, with one bounded query per metric name. Phase is not compared.
 */
export async function verifyRequiredRunSamples(
  client: PrometheusClient,
  request: Pick<RunMetricsRequest, "runId" | "start" | "end" | "stepSeconds">,
  required: MetricSample[],
  options: RawQueryOptions = {},
  recordQuery?: (query: Record<string, unknown>) => void
): Promise<void> {
  const id = escapeLabelValue(request.runId);
  const step = Math.max(1, Math.round(request.stepSeconds));
  for (const name of new Set(required.map((sample) => sample.metricName))) {
    const pending = new Set(required.filter((sample) => sample.metricName === name));
    const selector = `${name}{run_id="${id}"}`;
    try {
      for await (const chunk of readRawChunks(
        client,
        selector,
        request.start,
        request.end,
        step,
        options
      )) {
        for (const expected of pending)
          if (chunk.samples.some((sample) => matchesRequiredSample(sample, expected)))
            pending.delete(expected);
        recordQuery?.({
          selector: chunk.query,
          start: chunk.start,
          end: chunk.end,
          purpose: "startup_parameter_verification",
          observed: chunk.samples.length > 0
        });
        if (!pending.size) break;
      }
    } catch (error) {
      recordQuery?.({
        selector,
        start: request.start,
        end: request.end,
        purpose: "startup_parameter_verification",
        observed: false,
        reason: String(error).slice(0, 300)
      });
      throw error;
    }
    const expected = pending.values().next().value;
    if (expected)
      throw new Error(
        `run_metrics_required_sample_missing:${expected.metricName}:` +
          `${expected.labels.parameter ?? expected.labels.state ?? "unknown"}`
      );
  }
}

function matchesRequiredSample(sample: MetricSample, expected: MetricSample): boolean {
  return (
    sample.metricName === expected.metricName &&
    sample.value === expected.value &&
    Object.entries(expected.labels).every(
      ([key, value]) => key === "phase" || sample.labels[key] === value
    )
  );
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isoSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
