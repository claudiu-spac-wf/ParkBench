import { METRIC_DEFINITIONS_VERSION } from "../../../../packages/contracts/src/run-summary";
import { historicalSummaryInput } from "../../../../packages/metrics/src/historical-summary-input";
import { Repositories } from "../db/repositories";
import { ComparisonSummaryService } from "./comparison-summary-service";
const terminal = new Set([
  "SUCCEEDED",
  "INCOMPLETE",
  "THRESHOLD_FAILED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
]);
/** One lazy historical worker; raw requests share finalization's priority scheduler. */
export class HistoricalSummaryWorker {
  private queue: Array<{ runId: string; token: string }> = [];
  private queued = new Set<string>();
  private active = false;
  private closed = false;
  private controller?: AbortController;
  private waiters: Array<() => void> = [];
  private recovering = false;
  private recoveryTimer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly repositories: Repositories,
    private readonly summaries: ComparisonSummaryService
  ) {}
  schedule(runId: string): void {
    if (this.closed || this.queued.has(runId)) return;
    const run = this.repositories.getRun(runId);
    if (!run || !terminal.has(run.state)) return;
    const cache = this.repositories.getSummaryCache(runId);
    if (cache?.status === "READY" || (cache?.status === "LEGACY" && !cache.retryable)) return;
    if (
      cache?.status === "UNAVAILABLE" &&
      (!cache.retryable || Date.now() - Date.parse(cache.updatedAt) < 30000)
    )
      return;
    const token = this.repositories.claimSummaryAttempt(runId);
    if (!token) return;
    this.queued.add(runId);
    this.queue.push({ runId, token });
    queueMicrotask(() => void this.drain());
  }
  async recover(): Promise<void> {
    if (this.closed || this.recovering) return;
    if (!this.recoveryTimer) {
      this.recoveryTimer = setInterval(() => void this.recover(), 30000);
      this.recoveryTimer.unref();
    }
    this.recovering = true;
    try {
      const attempts = this.repositories.client.db
        .prepare(
          "SELECT run_id,lease_until FROM run_comparison_summaries WHERE semantic_version=? AND status='RECOMPUTING'"
        )
        .all(METRIC_DEFINITIONS_VERSION) as Array<{ run_id: string; lease_until: number }>;
      for (const attempt of attempts) {
        if (this.queued.has(attempt.run_id)) continue;
        if (attempt.lease_until > Date.now()) {
          try {
            await this.summaries.reconcileOrphan(attempt.run_id);
          } catch {
            /* Incomplete durable files remain private until lease expiry and recomputation. */
          }
        } else this.schedule(attempt.run_id);
      }
    } finally {
      this.recovering = false;
    }
  }
  idle(): Promise<void> {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  stop() {
    this.closed = true;
    clearInterval(this.recoveryTimer);
    this.queue = [];
    this.controller?.abort(new Error("summary_worker_stopped"));
    this.settle();
  }
  private settle() {
    if (!this.active && !this.queue.length) for (const resolve of this.waiters.splice(0)) resolve();
  }
  private async drain(): Promise<void> {
    if (this.active || this.closed) return;
    this.active = true;
    try {
      while (this.queue.length && !this.closed) {
        const item = this.queue.shift()!,
          run = this.repositories.getRun(item.runId);
        this.controller = new AbortController();
        let token = item.token;
        try {
          if (!run) continue;
          const cache = this.repositories.getSummaryCache(run.id);
          if (cache?.status === "READY") continue;
          if (cache?.attemptToken !== token || cache.leaseUntil <= Date.now()) {
            token = this.repositories.claimSummaryAttempt(run.id)!;
            if (!token) continue;
          }
          const input = historicalSummaryInput(run),
            prepared = await this.summaries.prepare(run, {
              origin: "historical_recompute",
              window: input.window,
              priority: "historical",
              signal: this.controller.signal,
              attemptToken: token
            });
          if (input.window.state !== "not_started" && !prepared.hasSupportedValues) {
            prepared.releaseLease?.();
            this.repositories.failSummaryAttempt(
              run.id,
              METRIC_DEFINITIONS_VERSION,
              token,
              "UNAVAILABLE",
              "source_unavailable",
              true
            );
            continue;
          }
          await this.summaries.publish(run, prepared);
        } catch (error) {
          if (!this.closed) {
            const legacy =
              String(error).includes("measurement_boundaries_missing") ||
              String(error).includes("legacy_semantics");
            try {
              this.repositories.failSummaryAttempt(
                item.runId,
                METRIC_DEFINITIONS_VERSION,
                token,
                legacy ? "LEGACY" : "UNAVAILABLE",
                legacy
                  ? "legacy_semantics"
                  : String(error).includes("summary_limit_exceeded")
                    ? "summary_limit_exceeded"
                    : String(error).includes("Timeout") || String(error).includes("query_timeout")
                      ? "query_timeout"
                      : "persistence_failed",
                !legacy
              );
            } catch {
              /* Replaced attempts cannot alter READY/new state. */
            }
          }
        } finally {
          this.queued.delete(item.runId);
          this.controller = undefined;
        }
      }
    } finally {
      this.active = false;
      this.settle();
    }
  }
}
