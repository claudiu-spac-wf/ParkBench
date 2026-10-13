import { RequiredMeasurementDefinition } from "../../contracts/src/scenario";
import { MetricSample } from "../../contracts/src/metrics";
import { CompletenessResult } from "../../contracts/src/run";
import type { Coverage } from "../../contracts/src/metric-definitions";
export interface ObserverSampleCount {
  observerId: string;
  phase: string;
  expected: number;
  observed: number;
  required: boolean;
  longestGapSeconds?: number;
  lastSuccessAt?: string;
  coverage?: Coverage;
}
export function calculateCompleteness(counts: ObserverSampleCount[]): CompletenessResult {
  const missing = (count: ObserverSampleCount) =>
    count.coverage
      ? count.observed === 0 || count.coverage.missingSeconds > 1e-8
      : count.observed < count.expected;
  const requiredGaps = counts
    .filter((x) => x.required && missing(x))
    .map((x) => ({
      observerId: x.observerId,
      phase: x.phase,
      expected: x.expected,
      observed: x.observed,
      missing: Math.max(1, x.expected - x.observed),
      ...(x.coverage ? { missingSeconds: x.coverage.missingSeconds } : {})
    }));
  const optionalWarnings = counts
    .filter((x) => !x.required && missing(x))
    .map(
      (x) => `${x.observerId}:${x.phase}:${Math.max(1, x.expected - x.observed)} samples missing`
    );
  return {
    complete: requiredGaps.length === 0,
    requiredGaps,
    optionalWarnings,
    evidence: counts.map((count) => ({
      observerId: count.observerId,
      phase: count.phase,
      longestGapSeconds: count.longestGapSeconds,
      lastSuccessAt: count.lastSuccessAt,
      ...(count.coverage ? { coverage: count.coverage } : {})
    }))
  };
}

export function calculateRequiredMeasurementGaps(
  requirements: RequiredMeasurementDefinition[],
  samples: MetricSample[]
): CompletenessResult["requiredGaps"] {
  const gaps: CompletenessResult["requiredGaps"] = [];
  for (const requirement of requirements) {
    for (const phase of requirement.phases ?? ["measurement"]) {
      const observed = samples.filter(
        (sample) =>
          sample.metricName === requirement.metricName &&
          (sample.labels.phase === phase || sample.labels.phase === undefined) &&
          isSampleAvailableForOpenEdgeMetric(sample, requirement.metricName, samples)
      ).length;
      const expected = 1;
      if (observed < expected) {
        const unavailable = openEdgeAvailabilityFor(requirement.metricName, phase, samples).find(
          (sample) => sample.value === 0
        );
        gaps.push({
          observerId: requirement.observerId ?? requirement.source,
          phase,
          expected,
          observed,
          missing: expected - observed,
          measurementId: requirement.id,
          metricName: requirement.metricName,
          source: requirement.source,
          ...(unavailable
            ? {
                availability: availabilityStatus(unavailable.labels.reason),
                availabilityReason: unavailable.labels.reason
              }
            : {})
        });
      }
    }
  }
  return gaps;
}

function availabilityStatus(
  reason: string | undefined
):
  | "unsupported"
  | "not_configured"
  | "not_licensed"
  | "not_collected"
  | "temporarily_unavailable"
  | undefined {
  if (reason === "vst_missing" || reason === "field_missing") return "unsupported";
  if (
    reason === "alternate_pool_disabled" ||
    reason === "statistics_range_excludes_object" ||
    reason === "statistics_disabled" ||
    reason === "source_disabled"
  )
    return "not_configured";
  if (reason === "license_required") return "not_licensed";
  if (reason === "not_applicable") return "not_collected";
  if (reason === "collection_timeout" || reason === "collection_error")
    return "temporarily_unavailable";
  return undefined;
}

function isSampleAvailableForOpenEdgeMetric(
  sample: MetricSample,
  metricName: string,
  samples: MetricSample[]
): boolean {
  const prefix = "parkbench_openedge_db_";
  if (!metricName.startsWith(prefix) || metricName === `${prefix}metric_available`) return true;
  const measurement = metricName.slice(prefix.length);
  return openEdgeAvailabilityFor(metricName, sample.labels.phase, samples).some(
    (availability) =>
      availability.value === 1 &&
      (!measurement.startsWith("latch_named_") ||
        (availability.timestamp === sample.timestamp &&
          availability.labels.run_id === sample.labels.run_id)) &&
      Object.entries(availability.labels).every(([key, value]) =>
        [
          "pool",
          "table",
          "index",
          "operation",
          "latch_name",
          "latch_type",
          "latch_id",
          "database",
          "database_epoch"
        ].includes(key)
          ? sample.labels[key] === value
          : true
      ) &&
      measurement === availability.labels.measurement
  );
}

function openEdgeAvailabilityFor(
  metricName: string,
  phase: string | undefined,
  samples: MetricSample[]
): MetricSample[] {
  const prefix = "parkbench_openedge_db_";
  if (!metricName.startsWith(prefix) || metricName === `${prefix}metric_available`) return [];
  const measurement = metricName.slice(prefix.length);
  return samples.filter(
    (sample) =>
      sample.metricName === `${prefix}metric_available` &&
      sample.labels.measurement === measurement &&
      (sample.labels.phase === phase || phase === undefined || sample.labels.phase === undefined)
  );
}
export function missingSamplesAsAbsent<T>(samples: T[] | undefined): T[] {
  return samples ?? [];
}
