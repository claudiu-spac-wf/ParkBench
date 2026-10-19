import {
  COMPARISON_METRIC_CATALOG,
  validateMetricSelections,
  type MetricSelection,
  type MetricStatistic
} from "../../../../../packages/contracts/src/comparison-metric-selection";

/** Change one recorded selector entry without affecting its same-metric siblings. */
export function changeMetricStatistic(
  selection: MetricSelection[],
  index: number,
  statistic: MetricStatistic,
  checked: boolean
): MetricSelection[] {
  const entry = selection[index];
  const descriptor = COMPARISON_METRIC_CATALOG.find((item) => item.metricId === entry?.metricId);
  if (!entry || !descriptor?.statistics.includes(statistic)) return selection;
  try {
    validateMetricSelections([entry]);
  } catch {
    return selection;
  }
  if (entry.statistics.includes(statistic) === checked) return selection;
  const statistics = checked
    ? [...entry.statistics, statistic]
    : entry.statistics.filter((item) => item !== statistic);
  return statistics.length
    ? selection.map((item, current) => (current === index ? { ...item, statistics } : item))
    : selection.filter((_, current) => current !== index);
}
export function supportedMetricSelection(selection: MetricSelection[]): {
  metrics: MetricSelection[];
  warnings: string[];
  unavailable: Array<{ index: number; selection: MetricSelection; message: string }>;
} {
  const metrics: MetricSelection[] = [],
    warnings: string[] = [],
    unavailable: Array<{ index: number; selection: MetricSelection; message: string }> = [];
  for (const [index, entry] of selection.entries()) {
    try {
      validateMetricSelections([entry]);
      metrics.push(entry);
    } catch {
      const message = `Recorded choice unavailable: ${entry.metricId}. It remains in the selection and can be removed or replaced.`;
      warnings.push(message);
      unavailable.push({ index, selection: entry, message });
    }
  }
  return { metrics, warnings, unavailable };
}
export function removeUnavailableMetricSelection(
  selection: MetricSelection[],
  index: number
): MetricSelection[] {
  return selection.filter((_, current) => current !== index);
}
export function toggleMetricSelection(
  selection: MetricSelection[],
  id: string,
  checked: boolean
): MetricSelection[] {
  if (!checked) return selection.filter((m) => m.metricId !== id);
  const d = COMPARISON_METRIC_CATALOG.find((d) => d.metricId === id);
  return d && !selection.some((m) => m.metricId === id)
    ? [...selection, { metricId: id, statistics: [...d.statistics], selectors: {} }]
    : selection;
}
