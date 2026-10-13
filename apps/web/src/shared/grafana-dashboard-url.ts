import { DASHBOARD_CATALOG, resolveDashboardUid } from "../../../../packages/dashboards/src/model";
export interface GrafanaDashboardContext {
  grafanaUrl?: string;
  runIds?: string[];
  variables?: { run_id?: string[]; experiment_id?: string[]; phase?: string[] };
  timeRange?: { from: string; to: string };
  alignedTimeRange?: { from: number; to: number };
}

/**
 * Dashboards served by the ParkBench Runs datasource. With several runs selected they are
 * aligned on elapsed time since measurement start (grafana-runs-datasource.v1), so their
 * time range comes from `alignedTimeRange` instead of clock time.
 */
export const ALIGNED_DASHBOARD_UIDS = new Set(
  DASHBOARD_CATALOG.filter((e) => e.runSelection === "multi").map((e) => e.uid)
);

export function grafanaDashboardUrl(
  context: GrafanaDashboardContext,
  uid?: string
): string | undefined {
  if (!context.grafanaUrl || !uid) return undefined;
  uid = resolveDashboardUid(uid);
  const variables = new URLSearchParams();
  const runIds = context.variables?.run_id ?? context.runIds ?? [];
  for (const runId of runIds) variables.append("var-run_id", runId);
  for (const experimentId of context.variables?.experiment_id ?? [])
    variables.append("var-experiment_id", experimentId);
  for (const phase of context.variables?.phase ?? []) variables.append("var-phase", phase);
  if (runIds.length > 1 && ALIGNED_DASHBOARD_UIDS.has(uid) && context.alignedTimeRange) {
    variables.set("from", String(context.alignedTimeRange.from));
    variables.set("to", String(context.alignedTimeRange.to));
  } else if (context.timeRange) {
    const from = Date.parse(context.timeRange.from);
    if (Number.isFinite(from)) variables.set("from", String(from));
    const to = context.timeRange.to === "now" ? "now" : Date.parse(context.timeRange.to);
    if (to === "now" || Number.isFinite(to)) variables.set("to", String(to));
  }
  return `${context.grafanaUrl.replace(/\/$/, "")}/d/${encodeURIComponent(uid)}?${variables.toString()}`;
}
