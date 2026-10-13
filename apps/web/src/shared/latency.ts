/** Database Latency (feature 016) display helpers shared by the run views. */
export const LATENCY_PARAMETER = "network.databaseLatencyMs";

/** Runs recorded before Database Latency existed ran with latency 0. */
export function latencyOf(configuration: Record<string, unknown> | undefined): number {
  const value = configuration?.[LATENCY_PARAMETER];
  return typeof value === "number" && value > 0 ? value : 0;
}

export function latencySummary(latencyMs: number, evidence?: { status?: string }): string {
  const base = latencyMs > 0 ? `${latencyMs} ms (≈${2 * latencyMs} ms RTT)` : "0 ms";
  return evidence?.status ? `${base} · ${evidence.status.replace("_", " ")}` : base;
}
