export const NATIVE_QUERY_LIMITS = Object.freeze({
  windowMs: 31 * 86400_000,
  deadlineMs: 30_000,
  concurrency: 4,
  requests: 64,
  responseBytes: 8 * 1048576,
  combinedBytes: 32 * 1048576,
  cacheEntries: 128,
  cacheBytes: 64 * 1048576
});
export type NativeLimits = { [K in keyof typeof NATIVE_QUERY_LIMITS]: number };
export class NativeBudgetError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export function nativeLimits(overrides: Partial<NativeLimits> = {}): NativeLimits {
  const limits = { ...NATIVE_QUERY_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new NativeBudgetError("native_limit_invalid:" + name);
  // Preserve the stricter existing per-response upstream control.
  limits.responseBytes = Math.min(limits.responseBytes, NATIVE_QUERY_LIMITS.responseBytes);
  return limits;
}
export class NativeQueryBudget {
  readonly controller = new AbortController();
  private requests = 0;
  private bytes = 0;
  private active = 0;
  private waiting: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];
  private deadline: number;
  private timer: ReturnType<typeof setTimeout>;
  constructor(
    readonly limits = nativeLimits(),
    private now = () => Date.now()
  ) {
    this.deadline = now() + limits.deadlineMs;
    this.timer = setTimeout(() => this.fail("native_query_deadline_exceeded"), limits.deadlineMs);
    this.timer.unref?.();
  }
  check() {
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    if (this.now() >= this.deadline) this.fail("native_query_deadline_exceeded");
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
  }
  fail(code: string) {
    if (!this.controller.signal.aborted) {
      const error = new NativeBudgetError(code);
      this.controller.abort(error);
      for (const waiter of this.waiting.splice(0)) waiter.reject(error);
    }
  }
  private abortable<T>(promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const aborted = () => reject(this.controller.signal.reason);
      this.controller.signal.addEventListener("abort", aborted, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => this.controller.signal.removeEventListener("abort", aborted));
      if (this.controller.signal.aborted) aborted();
    });
  }
  async fetch(url: string, params: URLSearchParams, fetcher: typeof fetch = fetch) {
    this.check();
    if (this.active >= this.limits.concurrency)
      await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
    else this.active++;
    try {
      this.check();
      if (this.requests >= this.limits.requests) {
        this.fail("native_query_request_budget_exceeded");
        this.check();
      }
      this.requests++;
      const response = await this.abortable(
        fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          signal: this.controller.signal
        })
      );
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value: chunk } = await this.abortable(reader.read());
            if (done) break;
            this.check();
            bytes += chunk.byteLength;
            this.bytes += chunk.byteLength;
            if (bytes > this.limits.responseBytes)
              this.fail("native_query_response_budget_exceeded");
            if (this.bytes > this.limits.combinedBytes)
              this.fail("native_query_combined_budget_exceeded");
            this.check();
            chunks.push(chunk);
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      this.check();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      this.check();
      if (!response.ok || body.status !== "success")
        throw new NativeBudgetError("native_query_upstream_error");
      return body;
    } catch (error) {
      this.fail(error instanceof NativeBudgetError ? error.code : "native_query_upstream_error");
      throw this.controller.signal.reason;
    } finally {
      const waiter = !this.controller.signal.aborted ? this.waiting.shift() : undefined;
      if (waiter) waiter.resolve();
      else this.active--;
    }
  }
  close() {
    clearTimeout(this.timer);
    if (this.waiting.length || this.active) this.fail("native_query_cancelled");
  }
}
export class NativeMatrixCache {
  private entries = new Map<string, { serialized: string; bytes: number }>();
  private used = 0;
  constructor(private limits = nativeLimits()) {}
  get accountedBytes() {
    return this.used;
  }
  get size() {
    return this.entries.size;
  }
  getMatchingPrefix(prefix: string) {
    const key = [...this.entries.keys()].find((k) => k.startsWith(prefix));
    return key ? this.get(key) : undefined;
  }
  setBatch(entries: Array<[string, unknown]>, check: () => void) {
    const previous = new Map(this.entries),
      used = this.used;
    try {
      for (const [key, value] of entries) {
        check();
        this.set(key, value);
        check();
      }
    } catch (error) {
      this.entries = previous;
      this.used = used;
      throw error;
    }
  }
  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return JSON.parse(entry.serialized);
  }
  set(key: string, value: unknown) {
    const serialized = JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized, "utf8");
    this.delete(key);
    if (bytes > this.limits.cacheBytes) return;
    while (
      this.entries.size >= this.limits.cacheEntries ||
      this.used + bytes > this.limits.cacheBytes
    )
      this.delete(this.entries.keys().next().value!);
    this.entries.set(key, { serialized, bytes });
    this.used += bytes;
  }
  private delete(key: string) {
    const previous = this.entries.get(key);
    if (previous) {
      this.used -= previous.bytes;
      this.entries.delete(key);
    }
  }
}
