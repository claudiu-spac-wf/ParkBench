import { ScenarioOperation } from "../../../packages/contracts/src/scenario";
import { OPENEDGE_WORKLOAD_TIMEOUT_MS } from "../../../packages/contracts/src/openedge";
export interface RequestResult {
  operation: string;
  phase?: string;
  status?: number;
  durationSeconds: number;
  requestId?: string;
  timeout?: boolean;
  latencyObservation?: "complete" | "lower_bound";
  timeoutMs?: number;
  error?: string;
  errorDetail?: string;
}
export class LoadgenHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = OPENEDGE_WORKLOAD_TIMEOUT_MS
  ) {}
  async health(path = "/health"): Promise<boolean> {
    try {
      return (
        await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) })
      ).ok;
    } catch {
      return false;
    }
  }
  async execute(operation: ScenarioOperation, body?: unknown): Promise<RequestResult> {
    const start = performance.now();
    const requestId = crypto.randomUUID();
    try {
      let response: Response | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await fetch(`${this.baseUrl}${operation.path}`, {
            method: operation.method,
            headers: { "content-type": "application/json", "x-parkbench-request": requestId },
            body: ["GET", "DELETE"].includes(operation.method) ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs)
          });
          if (response.status < 500 || attempt === 2) break;
        } catch (error) {
          lastError = error;
          if (isTimeoutError(error)) {
            return {
              operation: operation.id,
              requestId,
              durationSeconds: Math.max(this.timeoutMs, performance.now() - start) / 1000,
              timeout: true,
              timeoutMs: this.timeoutMs,
              latencyObservation: "lower_bound",
              error: "workload_timeout"
            };
          }
          if (attempt === 2) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
      if (!response) throw lastError ?? new Error("request_failed");
      const durationSeconds = (performance.now() - start) / 1000;
      if (response.status === 408) {
        const responseDetail = await boundedResponseError(response);
        return {
          operation: operation.id,
          requestId,
          status: response.status,
          durationSeconds: Math.max(this.timeoutMs, durationSeconds * 1000) / 1000,
          timeout: true,
          timeoutMs: this.timeoutMs,
          latencyObservation: "lower_bound",
          error: responseDetail ? `workload_timeout:${responseDetail}` : "workload_timeout"
        };
      }
      const expected = operation.expectedStatus ?? [200, 201, 202, 204];
      const failed = !expected.includes(response.status);
      return {
        operation: operation.id,
        requestId,
        status: response.status,
        durationSeconds,
        error: failed ? `unexpected_status:${response.status}` : undefined,
        errorDetail: failed ? await boundedResponseError(response) : undefined
      };
    } catch (error) {
      return {
        operation: operation.id,
        requestId,
        durationSeconds: (performance.now() - start) / 1000,
        error: String(error)
      };
    }
  }
}

async function boundedResponseError(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.json();
    if (
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
    )
      return payload.error.replaceAll(/\s+/g, " ").trim().slice(0, 256) || undefined;
  } catch {
    // Do not copy arbitrary or malformed response bodies into run evidence.
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  const value = error as { name?: string; code?: string };
  return (
    value?.name === "TimeoutError" ||
    value?.name === "AbortError" ||
    value?.code === "UND_ERR_ABORTED"
  );
}
