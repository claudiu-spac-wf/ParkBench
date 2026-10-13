import {
  ComparisonSelection,
  SummaryReader,
  ComparisonResult
} from "../../../../packages/contracts/src/comparison";
import {
  RunSummaryHeader,
  SummaryRow,
  Statistic
} from "../../../../packages/contracts/src/run-summary";
import { compareSummaryRow } from "./comparison-service";
import { selectedRunIds } from "./service";
export const CSV_COLUMNS = [
  "run_id",
  "run_name",
  "role",
  "state",
  "measurement_validity",
  "measurement_start",
  "measurement_end",
  "measurement_duration_seconds",
  "group",
  "metric",
  "coverage_scope",
  "service",
  "replica",
  "table",
  "pool",
  "direction",
  "rate_or_level_unit",
  "total_unit",
  "average",
  "p90",
  "p95",
  "total",
  "baseline_run_id",
  "baseline_average",
  "baseline_p90",
  "baseline_p95",
  "baseline_total",
  "average_difference",
  "average_difference_percent",
  "p90_difference",
  "p90_difference_percent",
  "p95_difference",
  "p95_difference_percent",
  "total_difference",
  "total_difference_percent",
  "average_status",
  "p90_status",
  "p95_status",
  "total_status",
  "total_coverage_model",
  "total_supported_contributors",
  "total_incomplete_contributors",
  "availability_reason",
  "difference_reason",
  "observed_seconds",
  "estimated_edge_seconds",
  "missing_seconds",
  "observation_step_seconds"
] as const;
export function csvValue(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("summary_non_finite");
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export function csvSummaryRow(
  runId: string,
  role: string,
  row: SummaryRow | undefined,
  header: RunSummaryHeader | undefined,
  baselineId: string | undefined,
  baselineRow: SummaryRow | undefined,
  baselineHeader: RunSummaryHeader | undefined,
  reason?: string
): string {
  const c = row?.coverage,
    h = header,
    comp = row
      ? compareSummaryRow(row, baselineRow, h, baselineHeader, role === "BASELINE")
      : undefined,
    total = row?.statistics.total?.coverage;
  const cells: Record<string, unknown> = {
    run_id: runId,
    run_name: h?.run.name,
    role,
    state: h?.run.state,
    measurement_validity: h?.run.measurementValidity,
    measurement_start: h?.windows.measurement.start,
    measurement_end: h?.windows.measurement.end,
    measurement_duration_seconds: h?.windows.measurement.durationSeconds,
    group: row?.group,
    metric: row?.displayName,
    coverage_scope: row?.coverageScope,
    ...row?.dimensions,
    rate_or_level_unit: row?.rateOrLevelUnit,
    total_unit: row?.totalUnit,
    baseline_run_id: baselineId,
    availability_reason:
      reason ??
      [...new Set(Object.values(row?.statistics ?? {}).flatMap((s) => s.reasons))].join(";"),
    difference_reason: [
      ...new Set(
        Object.values(comp?.differences ?? {})
          .map((d) => d.reason)
          .filter(Boolean)
      )
    ].join(";"),
    total_coverage_model: total?.coverageModel,
    total_supported_contributors: total?.supportedContributors,
    total_incomplete_contributors: total?.incompleteContributors,
    observed_seconds: c?.observedSeconds,
    estimated_edge_seconds: c?.estimatedEdgeSeconds,
    missing_seconds: c?.missingSeconds,
    observation_step_seconds: c?.observationStepSeconds
  };
  for (const key of ["average", "p90", "p95", "total"] as Statistic[]) {
    cells[key] = row?.statistics[key]?.value;
    cells[key + "_status"] = row?.statistics[key]?.status;
    cells["baseline_" + key] =
      role === "BASELINE" ? undefined : baselineRow?.statistics[key]?.value;
    cells[key + "_difference"] = comp?.differences[key]?.absoluteDifference;
    cells[key + "_difference_percent"] = comp?.differences[key]?.percentageDifference;
  }
  return CSV_COLUMNS.map((key) => csvValue(cells[key])).join(",") + "\n";
}
export async function* streamComparisonCsv(
  selection: ComparisonSelection,
  reader: SummaryReader
): AsyncGenerator<string> {
  const ids = selectedRunIds(selection);
  for (const id of ids)
    if (reader.read(id).status === "RECOMPUTING") throw new Error("comparison_summary_pending");
  const baseline = selection.baselineRunId ? reader.read(selection.baselineRunId) : undefined;
  yield CSV_COLUMNS.join(",") + "\n";
  for (const id of ids) {
    const read = reader.read(id),
      role = id === selection.baselineRunId ? "BASELINE" : "VARIANT";
    if (read.status !== "READY") {
      yield csvSummaryRow(
        id,
        role,
        undefined,
        read.header,
        selection.baselineRunId,
        undefined,
        baseline?.header,
        read.reason ?? read.status.toLowerCase()
      );
      continue;
    }
    let count = 0;
    for await (const row of reader.iterate(id)) {
      yield csvSummaryRow(
        id,
        role,
        row,
        read.header,
        selection.baselineRunId,
        selection.baselineRunId ? reader.find(selection.baselineRunId, row.rowKey) : undefined,
        baseline?.header
      );
      count++;
    }
    if (!count)
      yield csvSummaryRow(
        id,
        role,
        undefined,
        read.header,
        selection.baselineRunId,
        undefined,
        baseline?.header,
        "measurement_not_started"
      );
  }
}
/** Small already-hydrated callers share the same typed cells. Production downloads stream the store. */
export function comparisonCsv(value: any): string {
  if (value.contractVersion !== "comparison.v2") throw new Error("legacy_semantics");
  return (
    CSV_COLUMNS.join(",") +
    "\n" +
    (value.runs ?? [])
      .flatMap((r: any) =>
        r.rows.map((x: any) =>
          csvSummaryRow(
            r.runId,
            r.role,
            x.row,
            r.summary.header,
            value.baselineRunId,
            x.baselineRow,
            undefined
          )
        )
      )
      .join("")
  );
}
