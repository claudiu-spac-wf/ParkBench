import { MetricSample } from "../../../../packages/contracts/src/metrics";
import { RunEvidence } from "../../../../packages/contracts/src/run-evidence";

export interface ObserverOverheadPairEvidence {
  deterministicLoadSeed: number;
  inputs: {
    databaseImage?: string;
    pasImage?: string;
    observerImage?: string;
  };
  effectiveConfiguration: { values: Record<string, unknown> };
}

export function assertObserverOverheadPair(
  observerOff: ObserverOverheadPairEvidence,
  observerOn: ObserverOverheadPairEvidence
): void {
  const offValues = observerOff.effectiveConfiguration.values;
  const onValues = observerOn.effectiveConfiguration.values;
  if (
    offValues["database.metricsEnabled"] !== false ||
    onValues["database.metricsEnabled"] !== true
  )
    throw new Error("observer_overhead_toggle_invalid");
}

export function buildObserverOverheadEvidence(input: {
  mode: "observer_off" | "observer_on";
  pairedRunId: string;
  sharedLoadSeed: number;
  samples: MetricSample[];
  workload: RunEvidence["workload"];
}): NonNullable<RunEvidence["observerOverhead"]> {
  const measurement = input.samples.filter((sample) => sample.labels.phase === "measurement");
  const durations = measurement
    .filter(
      (sample) =>
        sample.metricName === "parkbench_observer_collection_duration_seconds" &&
        (sample.labels.kind === "openedge_db_v1" || sample.labels.service === "openedge-db")
    )
    .map((sample) => sample.value)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const cpuSeries = groupSamples(
    measurement.filter(
      (sample) =>
        sample.metricName === "container_cpu_usage_seconds_total" &&
        sample.labels.service === "db-observer"
    )
  );
  const cpuCoreSeconds = [...cpuSeries.values()].reduce((total, values) => {
    const ordered = values.sort((a, b) => a.timestamp - b.timestamp);
    if (ordered.length < 2) return total;
    return total + Math.max(0, ordered.at(-1)!.value - ordered[0].value);
  }, 0);
  const memory = measurement
    .filter(
      (sample) =>
        ["container_memory_working_set_bytes", "container_memory_usage_bytes"].includes(
          sample.metricName
        ) && sample.labels.service === "db-observer"
    )
    .map((sample) => sample.value)
    .filter(Number.isFinite);
  return {
    mode: input.mode,
    pairedRunId: input.pairedRunId,
    sharedLoadSeed: input.sharedLoadSeed,
    collectorDurationSeconds: {
      samples: durations.length,
      mean: mean(durations),
      p95: quantile(durations, 0.95)
    },
    observerResources: {
      ...(cpuSeries.size ? { cpuCoreSeconds } : {}),
      ...(memory.length ? { peakMemoryBytes: Math.max(...memory) } : {})
    },
    workload: {
      ...(input.workload.throughputPerSecond === undefined
        ? {}
        : { throughputPerSecond: input.workload.throughputPerSecond }),
      ...(input.workload.latencySeconds ? { latencySeconds: input.workload.latencySeconds } : {})
    }
  };
}

function groupSamples(samples: MetricSample[]): Map<string, MetricSample[]> {
  const groups = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    const key = [sample.labels.id, sample.labels.name, sample.labels.cpu]
      .filter(Boolean)
      .join("|") || sample.metricName;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return groups;
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined;
}

function quantile(values: number[], fraction: number): number | undefined {
  if (!values.length) return undefined;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}
