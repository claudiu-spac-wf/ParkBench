/** Additive instant totals for Grafana. Source breakdowns remain immutable. */
import { sumDiagnosticTotals, totalCoverageLabels } from "./diagnostic-totals";
export function sumRunTotals(rows: any[], check: () => void = () => {}): any[] {
  const totals = new Map<
    string,
    { time: number; parts: Array<{ value: unknown; coverage?: string }>; aligned: boolean }
  >();
  for (const row of rows) {
    check();
    const runId = row.metric?.run_id;
    const time = row.value?.[0];
    if (typeof runId !== "string" || !runId || !Number.isFinite(time))
      throw new Error("run_total_series_invalid");
    const total = totals.get(runId) ?? { time, parts: [], aligned: true };
    const raw = row.value?.[1];
    total.aligned &&= time === total.time;
    total.parts.push({ value: raw, coverage: row.metric.coverage_status });
    totals.set(runId, total);
  }
  return [...totals].map(([runId, total]) => {
    check();
    const reduced = total.aligned
      ? sumDiagnosticTotals(total.parts)
      : { value: null, coverage: "unavailable" as const };
    return {
      metric: { run_id: runId, aggregation: "run_total", ...totalCoverageLabels(reduced.coverage) },
      value: [total.time, reduced.value === null ? "NaN" : String(reduced.value)]
    };
  });
}
