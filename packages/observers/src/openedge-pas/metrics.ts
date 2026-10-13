export const PAS_WEB_METRICS: Record<
  string,
  { suffix: string; type: "counter" | "gauge"; scale?: number }
> = {
  servletRequests: { suffix: "requests_total", type: "counter" },
  postRequests: { suffix: "post_requests_total", type: "counter" },
  getRequests: { suffix: "get_requests_total", type: "counter" },
  putRequests: { suffix: "put_requests_total", type: "counter" },
  deleteRequests: { suffix: "delete_requests_total", type: "counter" },
  failedServletRequests: { suffix: "failed_requests_total", type: "counter" },
  postErrors: { suffix: "post_errors_total", type: "counter" },
  getErrors: { suffix: "get_errors_total", type: "counter" },
  putErrors: { suffix: "put_errors_total", type: "counter" },
  deleteErrors: { suffix: "delete_errors_total", type: "counter" },
  patchErrors: { suffix: "patch_errors_total", type: "counter" },
  optionsErrors: { suffix: "options_errors_total", type: "counter" },
  headErrors: { suffix: "head_errors_total", type: "counter" },
  traceErrors: { suffix: "trace_errors_total", type: "counter" },
  ablConnectErrors: { suffix: "abl_connect_errors_total", type: "counter" },
  successfulServletRequests: { suffix: "successful_requests_total", type: "counter" },
  avgABLProcessingTime: { suffix: "avg_abl_processing_seconds", type: "gauge", scale: 0.001 },
  minABLProcessingTime: { suffix: "min_abl_processing_seconds", type: "gauge", scale: 0.001 },
  maxABLProcessingTime: { suffix: "max_abl_processing_seconds", type: "gauge", scale: 0.001 },
  stdDevABLProcessingTime: {
    suffix: "stddev_abl_processing_seconds",
    type: "gauge",
    scale: 0.001
  },
  avgABLConnectTime: { suffix: "avg_abl_connect_seconds", type: "gauge", scale: 0.001 },
  minABLConnectTime: { suffix: "min_abl_connect_seconds", type: "gauge", scale: 0.001 },
  maxABLConnectTime: { suffix: "max_abl_connect_seconds", type: "gauge", scale: 0.001 },
  stdABLDevConnectTime: {
    suffix: "stddev_abl_connect_seconds",
    type: "gauge",
    scale: 0.001
  }
};

export function formatOpenEdgePasMetrics(
  payload: Record<string, number>,
  replica: number,
  capturedAtMs?: number
): string {
  const rows = Object.entries(PAS_WEB_METRICS).flatMap(([input, definition]) => {
    const value = payload[input];
    return Number.isFinite(value)
      ? [
          {
            name: `parkbench_openedge_pas_${definition.suffix}`,
            type: definition.type,
            value: value * (definition.scale ?? 1)
          }
        ]
      : [];
  });
  const typeLines = new Map<string, string>();
  for (const row of rows) typeLines.set(row.name, `# TYPE ${row.name} ${row.type}`);
  const dataLines = rows.map(
    ({ name, value }) =>
      `${name}{source="pas-management",replica="pas-${replica}"} ${value}${capturedAtMs === undefined ? "" : ` ${Math.round(capturedAtMs)}`}`
  );
  return [...typeLines.values(), ...dataLines].join("\n");
}

export function normalizePasMetrics(metrics: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(metrics).flatMap(([key, value]) => {
      const numeric =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : Number.NaN;
      return Number.isFinite(numeric) ? [[key.replace(/[^a-zA-Z0-9_]/g, "_"), numeric]] : [];
    })
  );
}

/** Preserve the original target ordinal before selecting endpoint subsets. */
export function selectPasReplicaTargets(
  targets: string[],
  replica?: number
): Array<{ target: string; replica: number }> {
  const all = targets.map((target, index) => ({ target, replica: index + 1 }));
  if (replica === undefined) return all;
  if (!Number.isInteger(replica) || replica < 1 || replica > all.length)
    throw new Error("pas_replica_invalid");
  return [all[replica - 1]];
}
export function pasMetricDefinition(suffix: string) {
  return Object.values(PAS_WEB_METRICS).find((d) => d.suffix === suffix);
}
