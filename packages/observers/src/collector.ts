import { MetricSample } from "../../contracts/src/metrics";
import { ObserverDeclaration } from "../../contracts/src/scenario";
import { ObserverAdapter, ObserverContext, observerLabels } from "./adapter";
import { ObserverRuntime } from "./observer-runtime";
import { PrometheusParseError } from "./http-observer";
import { observerDiagnostic } from "./diagnostics";

export interface ObserverFactory {
  create(declaration: ObserverDeclaration, context: ObserverContext): ObserverAdapter | undefined;
  supports?(kind: string): boolean;
  validate?(declaration: ObserverDeclaration): void;
}

export interface ObserverCollectionResult {
  expected: number;
  observed: number;
  required: boolean;
  observerId: string;
  phase: string;
  diagnostics: unknown[];
  failureCount?: number;
  longestGapSeconds?: number;
  lastSuccessAt?: string;
}

export class ObserverCollector {
  readonly runtimes: ObserverRuntime[];
  private readonly counts = new Map<string, ObserverCollectionResult>();

  constructor(
    declarations: ObserverDeclaration[],
    context: ObserverContext,
    factory: ObserverFactory,
    private readonly sink?: { append(samples: MetricSample[]): void }
  ) {
    this.runtimes = declarations.map((declaration) => {
      const adapter = factory.create(declaration, context) ?? unavailableAdapter(declaration);
      return new ObserverRuntime(declaration, adapter);
    });
  }

  async latchInventory(context: ObserverContext) {
    const databases = this.runtimes.filter((r) => r.declaration.kind === "openedge_db_v1");
    if (databases.length !== 1) throw new Error("named_latch_evidence_missing:collector_inventory");
    return databases[0].latchInventory(context);
  }
  async ready(
    context: ObserverContext,
    timeoutMs = 30000,
    shouldStop: () => boolean = () => false
  ): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let lastFailure = "observer_not_ready";
    do {
      const requiredFailures: string[] = [];
      for (const runtime of this.runtimes) {
        runtime.diagnostics.length = 0;
        let ready = false;
        try {
          ready = await runtime.ready();
        } catch (error) {
          runtime.diagnostics.push(
            observerDiagnostic(
              runtime.declaration.id,
              context.phase,
              "readiness_probe_failed",
              String(error)
            )
          );
        }
        if (!ready) {
          runtime.diagnostics.push(
            observerDiagnostic(runtime.declaration.id, context.phase, "observer_not_ready")
          );
          if (runtime.declaration.required) {
            requiredFailures.push(runtime.declaration.id);
          }
        }
      }
      if (!requiredFailures.length) return;
      const readinessDetails = requiredFailures.flatMap(
        (observerId) =>
          this.runtimes
            .find((runtime) => runtime.declaration.id === observerId)
            ?.diagnostics.filter((diagnostic) => diagnostic.errorCode === "readiness_probe_failed")
            .map((diagnostic) => `${observerId}:${diagnostic.message}`) ?? []
      );
      lastFailure = `observer_not_ready:${requiredFailures.join(",")}${
        readinessDetails.length ? `:${readinessDetails.join(";")}` : ""
      }`;
      if (shouldStop()) throw new Error("run_cancelled");
      if (Date.now() >= deadline) throw new Error(lastFailure);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (!shouldStop());
    throw new Error("run_cancelled");
  }

  async collectPhase(
    context: ObserverContext,
    durationSeconds: number,
    scale = 1,
    skipRequired = new Set<string>(),
    shouldStop: () => boolean = () => false,
    timing?: { startMs: number; endMs: number },
    checkInfrastructure?: () => Promise<void>
  ): Promise<ObserverCollectionResult[]> {
    // No upper clamp: the coordinator and the load generator's phase clock follow the
    // scenario's full phase lengths (up to the schema's 86400 s), so the collector must too.
    const durationMs = Math.max(0, durationSeconds * 1000 * scale);
    // Retain the historical grace period for callers without a shared schedule.
    // Scheduled runs use the exact adjacent deadline and stable scrape targets.
    const collectionDeadlineMs =
      durationMs > 0 ? durationMs + Math.min(250, durationMs) : durationMs;
    const deadline = timing?.endMs ?? Date.now() + collectionDeadlineMs;
    const startMs = timing?.startMs ?? Date.now();
    const phaseStartedAt = startMs / 1000;
    for (const runtime of this.runtimes) {
      const key = `${runtime.declaration.id}:${context.phase}`;
      if (!this.counts.has(key))
        this.counts.set(key, {
          observerId: runtime.declaration.id,
          phase: context.phase,
          expected: expectedIntervals(
            durationSeconds,
            runtime.declaration.samplingIntervalSeconds,
            scale
          ),
          observed: 0,
          required: runtime.declaration.required,
          diagnostics: [],
          attempts: 0,
          phaseStartedAt
        } as ObserverCollectionResult & { attempts: number; phaseStartedAt: number });
    }
    const intervalMs = Math.max(
      50,
      Math.min(
        ...this.runtimes.map((runtime) => runtime.declaration.samplingIntervalSeconds * 1000)
      )
    );
    let nextSampleAt = startMs;
    let first = true;
    do {
      if (shouldStop()) break;
      if (timing && Date.now() >= deadline) break;
      await checkInfrastructure?.();
      await Promise.all(
        this.runtimes.map((runtime) => this.sample(runtime, context, skipRequired, phaseStartedAt))
      );
      first = false;
      if (shouldStop()) break;
      if (durationMs === 0) break;
      nextSampleAt += intervalMs;
      const now = Date.now();
      if (nextSampleAt < now) {
        const missedIntervals = Math.floor((now - nextSampleAt) / intervalMs) + 1;
        nextSampleAt += missedIntervals * intervalMs;
      }
      // Schedule sample starts against the phase clock. Scrape work itself
      // must not add extra delay to every configured sampling interval.
      const wait = Math.min(Math.max(0, nextSampleAt - now), Math.max(0, deadline - now));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    } while (!shouldStop() && (first || Date.now() < deadline));
    for (const runtime of this.runtimes) {
      const count = this.counts.get(`${runtime.declaration.id}:${context.phase}`) as
        | (ObserverCollectionResult & {
            gapStartedAt?: number;
            phaseStartedAt: number;
          })
        | undefined;
      if (count?.gapStartedAt !== undefined)
        count.longestGapSeconds = Math.max(
          count.longestGapSeconds ?? 0,
          Date.now() / 1000 - count.gapStartedAt
        );
    }
    return [...this.counts.values()].filter((value) => value.phase === context.phase);
  }

  private async sample(
    runtime: ObserverRuntime,
    context: ObserverContext,
    skipRequired: Set<string>,
    phaseStartedAt: number
  ): Promise<void> {
    const key = `${runtime.declaration.id}:${context.phase}`;
    const count = (this.counts.get(key) ?? {
      observerId: runtime.declaration.id,
      phase: context.phase,
      expected: expectedIntervals(0, runtime.declaration.samplingIntervalSeconds, 1),
      observed: 0,
      required: runtime.declaration.required,
      diagnostics: [],
      attempts: 0,
      phaseStartedAt
    }) as ObserverCollectionResult & {
      attempts: number;
      phaseStartedAt: number;
      gapStartedAt?: number;
    };
    count.attempts += 1;
    const skipped = skipRequired.has(runtime.declaration.id) && runtime.declaration.required;
    let observed = false;
    if (!skipped) {
      try {
        const samples = await sampleWithRetry(runtime, context);
        if (!Array.isArray(samples)) throw new Error("observer_sample_batch_must_be_array");
        const valid = samples.filter((sample) => validSample(sample, context));
        const invalid = samples.filter((sample) => !validSample(sample, context));
        const parseDiagnostics =
          (samples as typeof samples & { diagnostics?: unknown[] }).diagnostics ?? [];
        if (invalid.length || parseDiagnostics.length) {
          count.failureCount = (count.failureCount ?? 0) + 1;
          addDiagnostic(count, {
            observerId: runtime.declaration.id,
            phase: context.phase,
            code: "invalid_observer_sample_dropped",
            sampleCount: samples.length,
            droppedCount: invalid.length + parseDiagnostics.length,
            parseDiagnostics: parseDiagnostics.slice(0, 3),
            invalidSamples: invalid.slice(0, 3).map((sample) => ({
              metricName: sample?.metricName,
              labels: sample?.labels,
              timestamp: sample?.timestamp,
              value: sample?.value
            }))
          });
        }
        observed = valid.length > 0;
        if (
          valid.length &&
          runtime.declaration.configuration?.authoritativePublisher !== "endpoint"
        )
          this.sink?.append(valid);
        if (observed) count.observed += 1;
        for (const diagnostic of runtime.diagnostics.splice(0)) addDiagnostic(count, diagnostic);
      } catch (error) {
        count.failureCount = (count.failureCount ?? 0) + 1;
        addDiagnostic(count, {
          observerId: runtime.declaration.id,
          phase: context.phase,
          code: error instanceof PrometheusParseError ? "observer_batch_rejected" : "sample_failed",
          error: String(error),
          diagnostics: error instanceof PrometheusParseError ? error.diagnostics : undefined
        });
      }
    }
    const now = Date.now() / 1000;
    if (observed) {
      const nowIso = new Date(now * 1000).toISOString();
      count.lastSuccessAt = nowIso;
      if (count.gapStartedAt !== undefined)
        count.longestGapSeconds = Math.max(count.longestGapSeconds ?? 0, now - count.gapStartedAt);
      count.gapStartedAt = undefined;
    } else {
      count.gapStartedAt ??= count.attempts === 1 ? count.phaseStartedAt : now;
      count.longestGapSeconds = Math.max(count.longestGapSeconds ?? 0, now - count.gapStartedAt);
    }
    this.counts.set(key, count);
    if (this.sink) {
      const labels = observerLabels(context, "observer", runtime.declaration.id);
      const timestamp = Date.now() / 1000;
      this.sink.append([
        {
          metricName: "parkbench_observer_scrapes_total",
          type: "counter",
          labels,
          timestamp,
          value: count.attempts,
          source: "observer-runtime"
        },
        {
          metricName: "parkbench_observer_scrape_failures_total",
          type: "counter",
          labels,
          timestamp,
          value: count.failureCount ?? 0,
          source: "observer-runtime"
        },
        {
          metricName: "parkbench_observer_expected_samples_total",
          type: "counter",
          labels,
          timestamp,
          value: count.expected,
          source: "observer-runtime"
        },
        {
          metricName: "parkbench_observer_observed_samples_total",
          type: "counter",
          labels,
          timestamp,
          value: count.observed,
          source: "observer-runtime"
        },
        {
          metricName: "parkbench_observer_incomplete",
          type: "gauge",
          labels,
          timestamp,
          value: count.observed < count.expected ? 1 : 0,
          source: "observer-runtime"
        },
        {
          metricName: "parkbench_observer_health",
          type: "gauge",
          labels,
          timestamp,
          value: count.observed > 0 ? 1 : 0,
          source: "observer-runtime"
        },
        {
          metricName: "parkbench_observer_longest_gap_seconds",
          type: "gauge",
          labels,
          timestamp,
          value: count.longestGapSeconds ?? 0,
          source: "observer-runtime"
        },
        {
          metricName: "parkbench_observer_last_success_timestamp_seconds",
          type: "gauge",
          labels,
          timestamp,
          value: count.lastSuccessAt ? Date.parse(count.lastSuccessAt) / 1000 : 0,
          source: "observer-runtime"
        }
      ]);
    }
  }
}

async function sampleWithRetry(runtime: ObserverRuntime, context: ObserverContext) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await runtime.sample(context);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

function expectedIntervals(
  durationSeconds: number,
  intervalSeconds: number,
  scale: number
): number {
  const scaledDuration = Math.max(0, durationSeconds * Math.max(scale, 0));
  return scaledDuration === 0 ? 1 : Math.max(1, Math.ceil(scaledDuration / intervalSeconds));
}

function validSample(sample: MetricSample, context: ObserverContext): boolean {
  if (
    !sample ||
    typeof sample !== "object" ||
    !sample.labels ||
    typeof sample.labels !== "object" ||
    Array.isArray(sample.labels)
  )
    return false;
  const labels = sample.labels;
  const entries = Object.entries(labels);
  return (
    typeof sample.metricName === "string" &&
    sample.metricName.length <= 128 &&
    /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(sample.metricName) &&
    Number.isFinite(sample?.timestamp) &&
    Number.isFinite(sample?.value) &&
    typeof sample?.source === "string" &&
    sample.source.length <= 256 &&
    entries.length <= 64 &&
    entries.every(
      ([key, value]) =>
        key.length <= 128 &&
        /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) &&
        typeof value === "string" &&
        value.length <= 1024
    ) &&
    labels.run_id === context.runId &&
    labels.experiment_id === context.experimentId &&
    labels.variant_id === context.variantId &&
    labels.repetition === String(context.repetition) &&
    labels.phase === context.phase
  );
}

function addDiagnostic(count: ObserverCollectionResult, diagnostic: unknown): void {
  if (count.diagnostics.length < 50) count.diagnostics.push(diagnostic);
  else if (count.diagnostics.length === 50)
    count.diagnostics.push({ code: "diagnostics_truncated", limit: 50 });
}

function unavailableAdapter(declaration: ObserverDeclaration): ObserverAdapter {
  return {
    id: declaration.id,
    kind: declaration.kind,
    async ready() {
      return false;
    },
    async sample() {
      throw new Error(`observer_adapter_unavailable:${declaration.kind}`);
    }
  };
}
