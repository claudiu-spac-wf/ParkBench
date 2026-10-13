import type { MetricSample } from "../../contracts/src/metrics";
import type { PrometheusClient } from "./prometheus-client";
import { RAW_CHUNK_SECONDS, RAW_RESPONSE_BYTES, RAW_RESPONSE_SAMPLES } from "./limits";
export interface RawQueryOptions {
  includeExactEnd?: boolean;
  signal?: AbortSignal;
  priority?: "finalization" | "historical";
  chunkSeconds?: number;
}
export class RawQueryScheduler {
  private active = 0;
  private queue: Array<{
    priority: number;
    start: () => void;
    signal?: AbortSignal;
    reject: (e: unknown) => void;
  }> = [];
  constructor(private readonly concurrency = 2) {
    if (concurrency < 1 || concurrency > 2) throw new Error("summary_concurrency_invalid");
  }
  run<T>(
    fn: () => Promise<T>,
    priority: "finalization" | "historical" = "historical",
    signal?: AbortSignal
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(signal?.reason);
        }
      };
      const item = {
        priority: priority === "finalization" ? 0 : 1,
        signal,
        reject,
        start: () => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          this.active++;
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.pump();
            });
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(item);
      this.queue.sort((a, b) => a.priority - b.priority);
      this.pump();
    });
  }
  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const next = this.queue.shift();
      next.start();
    }
  }
}
export const sharedRawQueryScheduler = new RawQueryScheduler(2);
export async function boundedResponseJson(
  response: Response,
  signal?: AbortSignal,
  allowVector = false
): Promise<any> {
  if (!response.ok) throw new Error("source_unavailable:" + response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("source_unavailable:empty_response");
  let bytes = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RAW_RESPONSE_BYTES) throw new Error("summary_limit_exceeded:raw_bytes");
      parts.push(value);
    }
    const data = JSON.parse(Buffer.concat(parts, bytes).toString("utf8"));
    if (
      data.status !== "success" ||
      !Array.isArray(data.data?.result) ||
      (data.data.resultType !== "matrix" && !(allowVector && data.data.resultType === "vector"))
    )
      throw new Error("source_unavailable:invalid_raw_response");
    let samples = 0;
    for (const series of data.data.result) {
      samples += (series.values ?? (series.value ? [series.value] : [])).length;
      if (samples > RAW_RESPONSE_SAMPLES) throw new Error("summary_limit_exceeded:raw_samples");
    }
    return data;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export async function* readRawChunks(
  client: PrometheusClient,
  selector: string,
  start: number,
  end: number,
  cadence: number,
  options: RawQueryOptions = {}
): AsyncGenerator<{ samples: MetricSample[]; query: string; start: number; end: number }> {
  if (!client.queryRawRange) throw new Error("legacy_semantics:raw_reader_unavailable");
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    !Number.isFinite(cadence) ||
    cadence <= 0
  )
    throw new Error("measurement_window_invalid");
  const chunk = options.chunkSeconds ?? RAW_CHUNK_SECONDS;
  let previous = new Set<string>();
  const identity = (s: MetricSample) =>
    JSON.stringify([
      s.metricName,
      Object.entries(s.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      s.timestamp,
      s.value
    ]);
  async function* read(
    a: number,
    b: number
  ): AsyncGenerator<{ samples: MetricSample[]; query: string; start: number; end: number }> {
    options.signal?.throwIfAborted();
    let samples: MetricSample[];
    try {
      samples = await client.queryRawRange(
        selector,
        Math.max(start, a - cadence - 0.001),
        b,
        cadence,
        { ...options, includeExactEnd: !!options.includeExactEnd && b === end }
      );
    } catch (error) {
      if (String(error).includes("summary_limit_exceeded") && b - a > 0.002) {
        const mid = Math.round((a + b) * 500) / 1000;
        yield* read(a, mid);
        yield* read(mid, b);
        return;
      }
      throw error;
    }
    const fresh = samples.filter(
      (s) =>
        s.timestamp >= start &&
        (s.timestamp < end ||
          (options.includeExactEnd && s.type === "counter" && s.timestamp === end)) &&
        !previous.has(identity(s))
    );
    previous = new Set(samples.filter((s) => s.timestamp >= b - cadence - 0.001).map(identity));
    yield { samples: fresh, query: selector, start: a, end: b };
  }
  for (let a = start; a < end; a += chunk) yield* read(a, Math.min(end, a + chunk));
}
