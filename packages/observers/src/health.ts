export interface ObserverHealth {
  observerId: string;
  status: "healthy" | "degraded" | "unavailable";
  lastSuccess?: string;
  error?: string;
}
export function health(
  observerId: string,
  status: ObserverHealth["status"],
  error?: string
): ObserverHealth {
  return {
    observerId,
    status,
    lastSuccess: status === "healthy" ? new Date().toISOString() : undefined,
    error
  };
}
