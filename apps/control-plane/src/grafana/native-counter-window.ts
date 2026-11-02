import { recordChartDecision } from "../measurement-diagnostics/chart-evidence";
/** Float counter reset/edge extrapolation follows Prometheus 3.5 extrapolatedRate.
 * Coverage checks are deliberately stricter: explicit gaps and stale edges fail.
 * Input belongs to one canonical identity, including exactly one database epoch.
 * Timestamps/windows are Unix seconds; callers clip phases before evaluation. */
export function counterWindow(
  points: Array<[number, number | null]>,
  start: number,
  end: number,
  cadence: number,
  includeStart = false
) {
  let selectedCount = 0, resetIntervals = 0;
  const record = (outcome: "SUCCEEDED" | "REJECTED", reason: string) => recordChartDecision({ stage: "NATIVE_COUNTER", outcome, effectiveStartMs: start * 1000, effectiveEndMs: end * 1000, cadenceMs: cadence * 1000, counts: { selectedPoints: selectedCount, resetIntervals }, reasonCodes: [reason, "counter_window_envelope"] });
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    !Number.isFinite(cadence) ||
    cadence <= 0
  )
    { record("REJECTED", "native_counter_window_invalid"); return null; }
  // Clipped observed startup totals retain their first sample as an anchor.
  // All ordinary counter windows keep Prometheus left-open selection.
  const selected = points.filter(
    ([t]) => (t > start || (includeStart && t === start)) && t <= end
  );
  selectedCount = selected.length;
  if (
    selected.length < 2 ||
    selected.some(([t, v]) => !Number.isFinite(t) || v === null || !Number.isFinite(v) || v < 0)
  )
    { record("REJECTED", "native_counter_observations_insufficient"); return null; }
  const first = selected[0],
    last = selected.at(-1)!;
  if (first[0] - start > cadence * 1.1 || end - last[0] > cadence * 1.1) { record("REJECTED", "native_counter_stale_edge"); return null; }
  let delta = last[1]! - first[1]!;
  for (let i = 1; i < selected.length; i++) {
    const previous = selected[i - 1],
      current = selected[i];
    if (current[0] <= previous[0] || current[0] - previous[0] > cadence * 1.5) { record("REJECTED", "native_counter_gap_or_conflict"); return null; }
    if (current[1]! < previous[1]!) { resetIntervals++; delta += previous[1]!; }
  }
  const interval = last[0] - first[0],
    average = interval / (selected.length - 1),
    threshold = average * 1.1;
  let toStart = first[0] - start,
    toEnd = end - last[0];
  if (toStart >= threshold) toStart = average / 2;
  if (delta > 0) toStart = Math.min(toStart, interval * (first[1]! / delta));
  if (toEnd >= threshold) toEnd = average / 2;
  const increase = (delta * (interval + toStart + toEnd)) / interval;
  record("SUCCEEDED", includeStart ? "counter_include_start_anchor" : "counter_left_open_window");
  return { increase, rate: increase / (end - start) };
}
