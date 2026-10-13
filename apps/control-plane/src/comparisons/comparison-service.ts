import { Run } from "../../../../packages/contracts/src/run";
import {
  RunSummaryHeader,
  SummaryRow,
  Statistic
} from "../../../../packages/contracts/src/run-summary";
import { ComparisonRow, Difference } from "../../../../packages/contracts/src/comparison";
export function isComparisonEligibleRun(run: Run | undefined): boolean {
  return !!run;
}
export function evaluateComparison(input: { baseline?: Run; variants: Run[] }): {
  eligibility: "VALID" | "DESCRIPTIVE_ONLY" | "REJECTED";
  reasons: string[];
} {
  if (!input.baseline) return { eligibility: "DESCRIPTIVE_ONLY", reasons: [] };
  return { eligibility: "VALID", reasons: [] };
}
export function compareSummaryRow(
  row: SummaryRow,
  baselineRow: SummaryRow | undefined,
  header: RunSummaryHeader | undefined,
  baselineHeader: RunSummaryHeader | undefined,
  isBaseline = false
): ComparisonRow {
  const differences: ComparisonRow["differences"] = {};
  for (const statistic of ["average", "p90", "p95", "total"] as Statistic[]) {
    const value = row.statistics[statistic],
      baseline = baselineRow?.statistics[statistic];
    if (!value && !baseline) continue;
    const d: Difference = {
      value: value?.value ?? null,
      baseline: isBaseline ? null : (baseline?.value ?? null),
      absoluteDifference: null,
      percentageDifference: null
    };
    if (isBaseline) d.reason = "baseline_row";
    else if (!baselineHeader) d.reason = "baseline_unavailable";
    else if (
      !baselineRow ||
      baselineRow.rowKey !== row.rowKey ||
      baseline?.value == null ||
      value?.value == null ||
      !Number.isFinite(value.value) ||
      !Number.isFinite(baseline.value)
    )
      d.reason = "statistic_unavailable";
    else {
      d.absoluteDifference = value.value - baseline.value;
      if (baseline.value === 0) d.reason = "zero_baseline";
      else {
        const percent = (d.absoluteDifference / baseline.value) * 100;
        if (Number.isFinite(percent)) d.percentageDifference = percent;
        else d.reason = "statistic_unavailable";
      }
      if (!Number.isFinite(d.absoluteDifference)) {
        d.absoluteDifference = null;
        d.percentageDifference = null;
        d.reason = "statistic_unavailable";
      }
    }
    differences[statistic] = d;
  }
  return { row, baselineRow: isBaseline ? undefined : baselineRow, differences };
}
export function missingCounterpart(
  row: SummaryRow,
  duration = row.coverage.durationSeconds
): SummaryRow {
  const coverage = {
    ...row.coverage,
    coverageModel: "single_source" as const,
    observedSeconds: 0,
    estimatedEdgeSeconds: 0,
    durationSeconds: duration,
    missingSeconds: duration,
    percentileBinCount: 0,
    observedAcquisitions: 0,
    reasons: ["not_collected" as const]
  };
  delete coverage.constituentSelector;
  delete coverage.supportedContributors;
  delete coverage.incompleteContributors;
  return {
    ...row,
    coverage,
    statistics: Object.fromEntries(
      Object.entries(row.statistics).map(([k, s]) => [
        k,
        {
          ...s,
          value: null,
          status: "unavailable",
          reasons: ["not_collected"],
          coverage,
          observedTotal: undefined,
          estimatedTotal: undefined
        }
      ])
    )
  };
}
