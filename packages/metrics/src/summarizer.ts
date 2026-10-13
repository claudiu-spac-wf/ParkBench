import { MetricSample, MetricSummary } from "../../contracts/src/metrics";

function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

export function summarize(
  samples: MetricSample[],
  runId: string,
  expectedSamples?: number,
  query = ""
): MetricSummary[] {
  const histogramBases = new Set(
    samples
      .filter(
        (sample) =>
          sample.metricName.endsWith("_bucket") ||
          (sample.type === "histogram" && sample.labels.le !== undefined)
      )
      .map((sample) => histogramBase(sample.metricName))
  );
  const summaries = histogramSummaries(samples, histogramBases, runId, expectedSamples, query);
  const scalarGroups = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    if (histogramBases.has(histogramBase(sample.metricName))) continue;
    const key = `${sample.metricName}|${JSON.stringify(sample.labels)}`;
    scalarGroups.set(key, [...(scalarGroups.get(key) ?? []), sample]);
  }
  summaries.push(
    ...[...scalarGroups.values()].map((values) =>
      scalarSummary(values, runId, expectedSamples, query)
    )
  );
  return summaries;
}

function scalarSummary(
  values: MetricSample[],
  runId: string,
  expectedSamples: number | undefined,
  query: string
): MetricSummary {
  const first = values[0];
  const numbers = values.map((x) => x.value);
  const counter = first.type === "counter" || first.metricName.endsWith("_total");
  const aggregateValues = counter ? counterIntervals(values) : numbers;
  const sum = counter
    ? aggregateValues.reduce((a, b) => a + b, 0)
    : numbers.reduce((a, b) => a + b, 0);
  const expected = expectedSamples ?? values.length;
  return {
    runId,
    metricName: first.metricName,
    type: first.type,
    labels: first.labels,
    phase: first.labels.phase,
    count: numbers.length,
    min: aggregateValues.length ? Math.min(...aggregateValues) : undefined,
    max: aggregateValues.length ? Math.max(...aggregateValues) : undefined,
    mean: aggregateValues.length ? sum / aggregateValues.length : undefined,
    p50: percentile(aggregateValues, 0.5),
    p95: percentile(aggregateValues, 0.95),
    p99: percentile(aggregateValues, 0.99),
    sum,
    expectedSamples: expected,
    observedSamples: numbers.length,
    completeness: expected ? numbers.length / expected : 1,
    prometheusQuery: query
  };
}

function histogramSummaries(
  samples: MetricSample[],
  bases: Set<string>,
  runId: string,
  expectedSamples: number | undefined,
  query: string
): MetricSummary[] {
  const groups = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    const base = histogramBase(sample.metricName);
    if (!bases.has(base)) continue;
    const labels = { ...sample.labels };
    delete labels.le;
    const key = `${base}|${JSON.stringify(labels)}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return [...groups.values()].map((values) =>
    histogramSummary(values, runId, expectedSamples, query)
  );
}

function histogramSummary(
  values: MetricSample[],
  runId: string,
  expectedSamples: number | undefined,
  query: string
): MetricSummary {
  const first = values[0];
  const buckets = new Map<string, MetricSample[]>();
  const countSamples: MetricSample[] = [];
  const sumSamples: MetricSample[] = [];
  for (const sample of values) {
    const base = histogramBase(sample.metricName);
    if (sample.metricName.endsWith("_count")) countSamples.push(sample);
    else if (sample.metricName.endsWith("_sum")) sumSamples.push(sample);
    else if (sample.labels.le !== undefined || sample.metricName.endsWith("_bucket")) {
      const le = sample.labels.le ?? "+Inf";
      buckets.set(le, [...(buckets.get(le) ?? []), sample]);
    } else if (base === histogramBase(first.metricName)) countSamples.push(sample);
  }
  const bucketDeltas = [...buckets.entries()]
    .map(([le, series]) => [le, counterValue(series)] as const)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => bucketBound(left) - bucketBound(right));
  const count = counterValue(countSamples) ?? bucketDeltas.find(([le]) => le === "+Inf")?.[1];
  const sum = counterValue(sumSamples);
  const expected =
    expectedSamples ??
    Math.max(1, countSamples.length, ...[...buckets.values()].map((value) => value.length));
  const observed = Math.max(
    1,
    countSamples.length,
    ...[...buckets.values()].map((value) => value.length)
  );
  const labels = { ...first.labels };
  delete labels.le;
  return {
    runId,
    metricName: histogramBase(first.metricName),
    type: "histogram",
    labels,
    phase: first.labels.phase,
    count: count ?? 0,
    min: bucketDeltas.length ? 0 : undefined,
    max: finiteHistogramMax(bucketDeltas),
    mean: count && sum !== undefined ? sum / count : undefined,
    p50: histogramQuantile(bucketDeltas, count, 0.5),
    p95: histogramQuantile(bucketDeltas, count, 0.95),
    p99: histogramQuantile(bucketDeltas, count, 0.99),
    sum,
    expectedSamples: expected,
    observedSamples: observed,
    completeness: expected ? observed / expected : 1,
    prometheusQuery: query
  };
}

function counterValue(samples: MetricSample[]): number | undefined {
  if (!samples.length) return undefined;
  if (samples.length === 1) return samples[0].value;
  return counterIntervals(samples).reduce((total, value) => total + value, 0);
}

function histogramQuantile(
  buckets: Array<readonly [string, number]>,
  count: number | undefined,
  quantile: number
): number | undefined {
  if (!buckets.length || !count || count <= 0) return undefined;
  const target = count * quantile;
  let previousCumulative = 0;
  let previousBound = 0;
  for (const [le, cumulative] of buckets) {
    if (cumulative >= target) {
      const upper = bucketBound(le);
      if (!Number.isFinite(upper)) return previousBound || undefined;
      const bucketCount = Math.max(0, cumulative - previousCumulative);
      if (!bucketCount) return upper;
      return (
        previousBound + ((target - previousCumulative) / bucketCount) * (upper - previousBound)
      );
    }
    previousCumulative = cumulative;
    previousBound = bucketBound(le);
  }
  return previousBound || undefined;
}

function finiteHistogramMax(buckets: Array<readonly [string, number]>): number | undefined {
  const finite = buckets.map(([le]) => bucketBound(le)).filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : undefined;
}

function bucketBound(value: string): number {
  return value === "+Inf" || value === "Inf" ? Number.POSITIVE_INFINITY : Number(value);
}

export function counterDelta(samples: MetricSample[]): number | undefined {
  if (!samples.length) return undefined;
  return counterIntervals(samples).reduce((total, value) => total + value, 0);
}

function counterIntervals(samples: MetricSample[]): number[] {
  const ordered = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  const intervals: number[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const difference = ordered[index].value - ordered[index - 1].value;
    intervals.push(difference >= 0 ? difference : ordered[index].value);
  }
  return intervals;
}

function histogramBase(metricName: string): string {
  if (metricName.endsWith("_bucket")) return metricName.slice(0, -7);
  if (metricName.endsWith("_count")) return metricName.slice(0, -6);
  if (metricName.endsWith("_sum")) return metricName.slice(0, -4);
  return metricName;
}
