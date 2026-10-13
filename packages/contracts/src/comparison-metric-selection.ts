import {
  RESOURCE_SUMMARY_CATALOG,
  DATABASE_SUMMARY_CATALOG,
  FILE_SUMMARY_CATALOG
} from "./summary-catalog";
import type { Coverage, StatisticStatus } from "./metric-definitions";
import type { Difference } from "./comparison";
export const COMPARISON_METRIC_SELECTION_VERSION = "comparison-metric-selection.v1" as const;
export const COMPARISON_METRIC_CATALOG_VERSION = "comparison-metrics.v1" as const;
export type MetricStatistic = "average" | "p90" | "p95" | "total" | "value";
export interface ComparisonMetricDescriptor {
  metricId: string;
  version: number;
  domain: "resource" | "database" | "workload" | "native_latch";
  displayName: string;
  group: string;
  scope: string;
  definitionId?: string;
  statistics: MetricStatistic[];
  units: Partial<Record<MetricStatistic, string>>;
  selectors: string[];
  improvementDirection: "higher" | "lower" | "unknown";
  default: boolean;
}
export interface MetricSelection {
  metricId: string;
  statistics: MetricStatistic[];
  selectors: Record<string, string>;
}
const resources: Record<string, string[]> = {
  platform: ["cpu.usage", "memory.used"],
  database: ["cpu.usage", "memory.used", "disk.read.operations", "disk.write.operations"],
  pas: ["cpu.usage"]
};
const databaseDefaults = [
  "db.records.read",
  "db.records.write",
  "db.buffer.logical.read",
  "db.buffer.logical.write",
  "db.blocks.read",
  "db.blocks.write"
];
const descriptors = [
  ...RESOURCE_SUMMARY_CATALOG,
  ...FILE_SUMMARY_CATALOG,
  ...DATABASE_SUMMARY_CATALOG
].map((d) => {
  const domain = d.definitionId.startsWith("db.") ? "database" : "resource";
  return {
    metricId: `${domain}.${domain === "resource" ? `${d.group}.` : ""}${d.definitionId}`,
    version: 1,
    domain,
    displayName: `${d.group[0].toUpperCase() + d.group.slice(1)} · ${d.displayName}`,
    group: d.group,
    scope: d.coverageScope,
    definitionId: d.definitionId,
    statistics: d.supportedStatistics,
    units: Object.fromEntries(
      d.supportedStatistics.map((s) => [s, s === "total" ? d.totalUnit : d.rateOrLevelUnit])
    ),
    selectors: [...d.allowedDimensions],
    improvementDirection: ["db.records.read", "db.records.write"].includes(d.definitionId)
      ? "higher"
      : databaseDefaults.includes(d.definitionId) ||
          ["cpu.usage", "memory.used", "disk.read.operations", "disk.write.operations"].includes(
            d.definitionId
          )
        ? "lower"
        : "unknown",
    default:
      domain === "database"
        ? databaseDefaults.includes(d.definitionId)
        : (resources[d.group]?.includes(d.definitionId) ?? false)
  } as ComparisonMetricDescriptor;
});
const workload: [string, string, string, MetricStatistic, "higher" | "lower"][] = [
  ["completed", "Completed requests", "requests", "total", "higher"],
  ["errors", "Request errors", "requests", "total", "lower"],
  ["timeouts", "Timeouts", "requests", "total", "lower"],
  [
    "completed.rate",
    "Completed request rate",
    "completed_requests_per_second",
    "average",
    "higher"
  ],
  ...(["p50", "p95", "p99"] as const).map(
    (s) =>
      [`latency.${s}`, `Latency ${s}`, "seconds", "value", "lower"] as [
        string,
        string,
        string,
        MetricStatistic,
        "lower"
      ]
  )
];
export const COMPARISON_METRIC_CATALOG: ComparisonMetricDescriptor[] = [
  ...new Map(descriptors.map((d) => [d.metricId, d])).values(),
  ...workload.map(([id, name, unit, stat, direction]) => ({
    metricId: `workload.${id}`,
    version: 1,
    domain: "workload" as const,
    displayName: `Workload · ${name}`,
    group: "workload",
    scope: "measurement",
    statistics: [stat],
    units: { [stat]: unit },
    selectors: [],
    improvementDirection: direction,
    default: false
  })),
  ...(["waits", "duration"] as const).map((id) => ({
    metricId: `native_latch.${id}`,
    version: 1,
    domain: "native_latch" as const,
    displayName: `Named latches · ${id === "waits" ? "Wait naps" : "Wait or spin duration"}`,
    group: "database",
    scope: "named_latch",
    statistics: ["total"] as MetricStatistic[],
    units: { total: id === "waits" ? "naps" : "seconds" },
    selectors: ["latch_name", "latch_type"],
    improvementDirection: "lower" as const,
    default: false
  }))
];
export const DEFAULT_COMPARISON_METRICS: MetricSelection[] = COMPARISON_METRIC_CATALOG.filter(
  (d) => d.default
).map((d) => ({ metricId: d.metricId, statistics: [...d.statistics], selectors: {} }));
export interface MetricSelectionRequest {
  contractVersion: typeof COMPARISON_METRIC_SELECTION_VERSION;
  selectionRevision: number;
  runIds: string[];
  metrics: MetricSelection[];
  limit?: number;
  cursor?: string;
}
export interface ProjectedMetricValue {
  rowId: string;
  runId: string;
  runState: string;
  measurementValidity: string;
  metricId: string;
  descriptorVersion: number;
  statistic: MetricStatistic;
  unit: string;
  dimensions: Record<string, string>;
  value: number | null;
  availability: StatisticStatus;
  reasons: string[];
  coverage?: Coverage;
  sourceReferences: unknown[];
  sourceIdentity: string;
  warnings: string[];
  baseline?: {
    runId: string;
    value: number | null;
    availability: StatisticStatus;
    sourceIdentity: string;
  };
  difference: Difference;
}
export interface MetricSelectionResponse {
  contractVersion: typeof COMPARISON_METRIC_SELECTION_VERSION;
  comparisonId: string;
  selectionRevision: number;
  selectionIdentity: string;
  sourceIdentity: string;
  rows: ProjectedMetricValue[];
  hasMore: boolean;
  nextCursor?: string;
  returnedRowCount: number;
}
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, any>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
export function validateMetricSelections(
  value: unknown,
  max = 32,
  allowUnknown = false
): asserts value is MetricSelection[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("comparison_metric_selection_invalid");
  const identities = new Set<string>();
  for (const m of value) {
    if (
      !object(m) ||
      !exact(m, ["metricId", "statistics", "selectors"]) ||
      typeof m.metricId !== "string" ||
      m.metricId.length > 256 ||
      !Array.isArray(m.statistics) ||
      !m.statistics.length ||
      m.statistics.length > 5 ||
      new Set(m.statistics).size !== m.statistics.length ||
      !object(m.selectors)
    )
      throw new Error("comparison_metric_selection_invalid");
    const d = COMPARISON_METRIC_CATALOG.find((d) => d.metricId === m.metricId);
    if (!d && !allowUnknown) throw new Error("comparison_metric_unknown");
    if (
      m.statistics.some(
        (s: unknown) =>
          !["average", "p90", "p95", "total", "value"].includes(s as string) ||
          (!allowUnknown && d && !d.statistics.includes(s as MetricStatistic))
      )
    )
      throw new Error("comparison_metric_statistic_unsupported");
    if (
      Object.entries(m.selectors).some(
        ([k, v]) =>
          (!allowUnknown && !d?.selectors.includes(k)) ||
          k.length > 256 ||
          /^(run(_id)?|baseline|epoch|database_epoch|latch_id|publisher|time|start|end|window_start|window_end)$/.test(
            k
          ) ||
          typeof v !== "string" ||
          !v ||
          v.length > 256
      )
    )
      throw new Error("comparison_metric_selector_invalid");
    const identity = JSON.stringify([
      m.metricId,
      Object.entries(m.selectors).sort(),
      ...(allowUnknown ? [[...m.statistics].sort()] : [])
    ]);
    if (identities.has(identity)) throw new Error("comparison_metric_duplicate");
    identities.add(identity);
  }
}
export function validateMetricSelectionRequest(
  value: unknown
): asserts value is MetricSelectionRequest {
  if (
    !object(value) ||
    !exact(value, [
      "contractVersion",
      "selectionRevision",
      "runIds",
      "metrics",
      "limit",
      "cursor"
    ]) ||
    value.contractVersion !== COMPARISON_METRIC_SELECTION_VERSION ||
    !Number.isSafeInteger(value.selectionRevision) ||
    value.selectionRevision < 1 ||
    !Array.isArray(value.runIds) ||
    !value.runIds.length ||
    value.runIds.length > 25 ||
    new Set(value.runIds).size !== value.runIds.length ||
    value.runIds.some((id: unknown) => typeof id !== "string" || !id || id.length > 256) ||
    (value.limit !== undefined &&
      (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 500)) ||
    (value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length > 8192))
  )
    throw new Error("comparison_metric_request_invalid");
  validateMetricSelections(value.metrics);
}
export function selectionIdentity(metrics: MetricSelection[]): string {
  return JSON.stringify(
    metrics
      .map((m) => [m.metricId, [...m.statistics].sort(), Object.entries(m.selectors).sort()])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
}
/** Quality does not take part in numeric eligibility. Callers must establish a stable source first. */
export function numericDifference(
  value: number | null,
  baseline: number | null,
  matched = true
): Difference {
  const d: Difference = { value, baseline, absoluteDifference: null, percentageDifference: null };
  if (!matched) d.reason = "statistic_semantics_mismatch";
  else if (
    value === null ||
    baseline === null ||
    !Number.isFinite(value) ||
    !Number.isFinite(baseline)
  )
    d.reason = "statistic_unavailable";
  else if (baseline === 0) d.reason = "zero_baseline";
  else {
    const absolute = value - baseline,
      percent = (absolute / baseline) * 100;
    if (Number.isFinite(absolute) && Number.isFinite(percent)) {
      d.absoluteDifference = absolute;
      d.percentageDifference = percent;
    } else d.reason = "statistic_unavailable";
  }
  return d;
}
export function validateMetricSelectionResponse(
  value: unknown
): asserts value is MetricSelectionResponse {
  if (
    !object(value) ||
    value.contractVersion !== COMPARISON_METRIC_SELECTION_VERSION ||
    typeof value.comparisonId !== "string" ||
    !Number.isSafeInteger(value.selectionRevision) ||
    typeof value.selectionIdentity !== "string" ||
    typeof value.sourceIdentity !== "string" ||
    !Array.isArray(value.rows) ||
    value.rows.length > 500 ||
    value.returnedRowCount !== value.rows.length ||
    typeof value.hasMore !== "boolean" ||
    (value.hasMore && !value.nextCursor)
  )
    throw new Error("comparison_metric_response_invalid");
  for (const row of value.rows) {
    const d = COMPARISON_METRIC_CATALOG.find((d) => d.metricId === row?.metricId);
    if (
      !object(row) ||
      !d ||
      row.descriptorVersion !== d.version ||
      !d.statistics.includes(row.statistic) ||
      row.unit !== d.units[row.statistic as MetricStatistic] ||
      typeof row.rowId !== "string" ||
      row.rowId.length > 256 ||
      typeof row.runId !== "string" ||
      typeof row.sourceIdentity !== "string" ||
      !object(row.dimensions) ||
      Object.values(row.dimensions).some((v) => typeof v !== "string" || v.length > 256) ||
      !Array.isArray(row.sourceReferences) ||
      !Array.isArray(row.warnings) ||
      row.warnings.some((v: unknown) => typeof v !== "string") ||
      !Array.isArray(row.reasons) ||
      !["available", "partial", "estimated", "unavailable"].includes(row.availability) ||
      !object(row.difference) ||
      (row.value !== null &&
        (typeof row.value !== "number" ||
          !Number.isFinite(row.value) ||
          row.availability === "unavailable")) ||
      (row.value === null && (row.availability !== "unavailable" || !row.reasons.length)) ||
      ["value", "baseline", "absoluteDifference", "percentageDifference"].some(
        (k) =>
          row.difference[k] !== null &&
          (typeof row.difference[k] !== "number" || !Number.isFinite(row.difference[k]))
      ) ||
      (row.baseline !== undefined &&
        (!object(row.baseline) ||
          typeof row.baseline.runId !== "string" ||
          typeof row.baseline.sourceIdentity !== "string" ||
          !["available", "partial", "estimated", "unavailable"].includes(
            row.baseline.availability
          ) ||
          (row.baseline.value !== null && !Number.isFinite(row.baseline.value))))
    )
      throw new Error("comparison_metric_response_invalid");
  }
}
