export const DB_METRIC_ALLOWLIST = new Set([
  "_ActBuffer",
  "_ActSummary",
  "_TableStat",
  "_IndexStat",
  "_Checkpoint",
  "_ActPWs",
  "_ActBILog",
  "_Logging",
  "_ActIOType",
  "_ActLock",
  "_Latch",
  "_DbParams",
  "_DbStatus"
]);
export function assertAllowedDatabaseMetric(metric: string): void {
  if (!DB_METRIC_ALLOWLIST.has(metric)) throw new Error(`unknown_openedge_metric:${metric}`);
}
