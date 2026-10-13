export const QUEUE_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000] as const;

export type QueueFailureKind =
  "temporary_capacity" | "permanent_capacity" | "configuration" | "blocked";

export function nextCapacityRetry(
  retryCount: number,
  now = new Date()
): { retryCount: number; nextRetryAt: string } {
  const index = Math.min(Math.max(0, retryCount), QUEUE_RETRY_DELAYS_MS.length - 1);
  return {
    retryCount: retryCount + 1,
    nextRetryAt: new Date(now.getTime() + QUEUE_RETRY_DELAYS_MS[index]).toISOString()
  };
}

export function classifyQueueFailure(error: unknown): QueueFailureKind {
  const message = String(error);
  if (/capacity|resource|disk|memory/i.test(message))
    return /temporary|busy|available/i.test(message) ? "temporary_capacity" : "permanent_capacity";
  if (/asset|scenario|parameter|configuration|preflight/i.test(message)) return "configuration";
  return "blocked";
}

export function assertPreflightPassed(preflight: { valid?: boolean } | undefined): void {
  if (!preflight?.valid) throw new Error("preflight_required_before_resource_creation");
}
