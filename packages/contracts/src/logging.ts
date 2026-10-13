import { redactSecrets } from "./redaction";
export function requestId(prefix = "req"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
export function structuredLog(
  level: string,
  message: string,
  fields: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(redactSecrets(fields) as Record<string, unknown>)
  });
}
