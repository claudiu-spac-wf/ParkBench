import { createNativeDiagnostics } from "../grafana/native-diagnostics";
import { timelineFromRun } from "../grafana/run-timeline";
import type { NativeProjection } from "./metric-selection-service";
/** This adapter uses the same owned phase, epoch, availability and counter reducer as Grafana. */
export function createNamedLatchProjection(options: {
  prometheusUrl: string;
  fetch?: typeof fetch;
}): NativeProjection {
  const query = createNativeDiagnostics(options);
  return async (run, summary, selection, signal, budget) => {
    const inventories = (run.environmentSnapshot as any)?.namedLatchInventories;
    if (
      !Array.isArray(inventories) ||
      !inventories.length ||
      inventories.some((i) => i.runId !== run.id)
    )
      return [];
    const window = summary.header?.windows.measurement;
    if (
      !window?.start ||
      !window.end ||
      window.durationSeconds <= 0 ||
      summary.header?.run.id !== run.id
    )
      return [];
    if (signal?.aborted) throw new Error("comparison_metric_projection_aborted");
    const timeline = timelineFromRun(run),
      start = Date.parse(window.start),
      end = Date.parse(window.end);
    const metric =
      selection.metricId === "native_latch.waits"
        ? "latch_named_waits_total"
        : "latch_named_wait_or_spin_duration_seconds_total";
    const labels = {
      run_id: run.id,
      metric,
      view: "total",
      group: "name_type",
      phase: "measurement",
      window_start: String(start),
      window_end: String(end),
      ...selection.selectors
    };
    const rows = await query({
      matchers: Object.entries(labels).map(([name, value]) => ({
        name,
        value,
        op: "=" as const,
        start: 0,
        end: 0
      })),
      timelines: [timeline],
      start: end,
      end,
      step: 1000,
      instant: true,
      budget,
      shift: () => 0
    });
    if (signal?.aborted) throw new Error("comparison_metric_projection_aborted");
    return rows.map((row) => {
      const dimensions = {
        database: row.metric.database,
        latch_name: row.metric.latch_name,
        latch_type: row.metric.latch_type
      };
      const raw = row.value?.[1],
        value =
          raw !== undefined && raw !== null && raw !== "NaN" && Number.isFinite(Number(raw))
            ? Number(raw)
            : null;
      return {
        dimensions,
        value,
        reasons: value === null ? ["named_latch_statistic_unavailable"] : [],
        sourceReferences: [
          {
            source: "native_db_endpoint",
            metric,
            measurementWindow: window,
            instances: row.metric.latch_instances ?? row.metric.latch_id,
            epochs: row.metric.database_epochs ?? row.metric.database_epoch
          }
        ]
      };
    });
  };
}
