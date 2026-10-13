/** Additive instant totals for Grafana. Source breakdowns remain immutable. */
export function sumRunTotals(rows: any[], check: () => void = () => {}): any[] {
  const totals = new Map<string, { time: number; value: number; available: boolean }>();
  for (const row of rows) {
    check();
    const runId = row.metric?.run_id;
    const time = row.value?.[0];
    if (typeof runId !== "string" || !runId || !Number.isFinite(time))
      throw new Error("run_total_series_invalid");
    const total = totals.get(runId) ?? { time, value: 0, available: true };
    const raw = row.value?.[1];
    const value =
      typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
    total.available &&= time === total.time && Number.isFinite(value) && value >= 0;
    total.value += value;
    totals.set(runId, total);
  }
  return [...totals].map(([runId, total]) => {
    check();
    return {
      metric: { run_id: runId, aggregation: "run_total" },
      value: [
        total.time,
        total.available && Number.isFinite(total.value) ? String(total.value) : "NaN"
      ]
    };
  });
}
