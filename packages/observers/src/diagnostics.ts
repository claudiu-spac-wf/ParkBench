export interface ObserverDiagnostic {
  observerId: string;
  phase: string;
  errorCode: string;
  occurredAt: string;
  retryCount: number;
  message?: string;
}
export function observerDiagnostic(
  observerId: string,
  phase: string,
  errorCode: string,
  message?: string,
  retryCount = 0
): ObserverDiagnostic {
  return {
    observerId,
    phase,
    errorCode,
    occurredAt: new Date().toISOString(),
    retryCount,
    message
  };
}
