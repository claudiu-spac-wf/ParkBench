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
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    !Number.isFinite(cadence) ||
    cadence <= 0
  )
    return null;
  // Clipped observed startup totals retain their first sample as an anchor.
  // All ordinary counter windows keep Prometheus left-open selection.
  const selected = points.filter(
    ([t]) => (t > start || (includeStart && t === start)) && t <= end
  );
  if (
    selected.length < 2 ||
    selected.some(([t, v]) => !Number.isFinite(t) || v === null || !Number.isFinite(v) || v < 0)
  )
    return null;
  const first = selected[0],
    last = selected.at(-1)!;
  if (first[0] - start > cadence * 1.1 || end - last[0] > cadence * 1.1) return null;
  let delta = last[1]! - first[1]!;
  for (let i = 1; i < selected.length; i++) {
    const previous = selected[i - 1],
      current = selected[i];
    if (current[0] <= previous[0] || current[0] - previous[0] > cadence * 1.5) return null;
    if (current[1]! < previous[1]!) delta += previous[1]!;
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
  return { increase, rate: increase / (end - start) };
}
