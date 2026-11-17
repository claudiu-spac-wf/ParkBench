export const EXIT_CODES = {
  success: 0,
  cancelled: 10,
  infrastructure: 20,
  threshold: 30,
  invalid: 40,
  unexpected: 50
} as const;

export function loadgenExitCode(summary: {
  shutdownReason: string;
  timeoutCount: number;
  thresholdFailed: boolean;
  phaseResults?: Record<string, { timeoutCount?: number }>;
}): number {
  if (summary.shutdownReason === "cancelled") return EXIT_CODES.cancelled;
  if (
    summary.shutdownReason === "timeout" ||
    summary.timeoutCount > 0 ||
    Object.values(summary.phaseResults ?? {}).some((phase) => (phase.timeoutCount ?? 0) > 0)
  )
    return EXIT_CODES.infrastructure;
  return summary.thresholdFailed ? EXIT_CODES.threshold : EXIT_CODES.success;
}
