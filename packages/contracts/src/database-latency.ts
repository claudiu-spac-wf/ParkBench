/** Evidence that a run's Database Latency was applied and confirmed (feature 016). */
export const DATABASE_LATENCY_CONTRACT_VERSION = "db-latency.v1" as const;

export const DATABASE_LATENCY_UNSUPPORTED = "database_latency_unsupported";
export const DATABASE_LATENCY_APPLY_FAILED = "database_latency_apply_failed";
export const DATABASE_LATENCY_UNCONFIRMED = "database_latency_unconfirmed";

export const DATABASE_LATENCY_UNSUPPORTED_MESSAGE =
  "The Docker host kernel does not provide netem/prio/u32 traffic control. Load the `sch_netem` module or run without Database Latency.";

export interface DatabaseLatencyTarget {
  service: string;
  device: string;
  peers: Array<{ service: string; ip: string }>;
  qdisc: string;
  filters: string;
}

export interface DatabaseLatencyProbe {
  from: string;
  to: string;
  samples: number;
  baselineRttMs: number;
  measuredRttMs: number;
  expectedDeltaMs: number;
  toleranceMs: { min: number; max: number };
}

export interface DatabaseLatencyEvidence {
  contractVersion: typeof DATABASE_LATENCY_CONTRACT_VERSION;
  requestedMs: number;
  appliedMs: number;
  mode: "none" | "netem" | "simulated";
  status: "not_requested" | "confirmed" | "failed" | "simulated";
  failureCode?: string;
  targets: DatabaseLatencyTarget[];
  probe?: DatabaseLatencyProbe;
  /** Wall time of the apply-and-confirm step. */
  applyDurationMs?: number;
  appliedAt: string;
}

export function notRequestedLatencyEvidence(): DatabaseLatencyEvidence {
  return {
    contractVersion: DATABASE_LATENCY_CONTRACT_VERSION,
    requestedMs: 0,
    appliedMs: 0,
    mode: "none",
    status: "not_requested",
    targets: [],
    appliedAt: new Date().toISOString()
  };
}

/**
 * Accepted round-trip increase for a one-way delay of N ms: 2N ± max(10% of 2N, 1 ms), the same
 * tolerance as spec SC-007.
 */
export function latencyTolerance(requestedMs: number): { min: number; max: number } {
  const expected = 2 * requestedMs;
  const slack = Math.max(0.1 * expected, 1);
  return { min: expected - slack, max: expected + slack };
}
