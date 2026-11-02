import { randomUUID } from "node:crypto";
import type { EvidenceInput } from "../measurement-evidence";
export interface NativeCollectionCaller {
  callerRole: "CONTROLLER" | "SCRAPER" | "UNKNOWN";
  requestId?: string;
  /** Trusted start of the active source interval, supplied by the run clock. */
  minimumCapturedAtMs?: number;
}
/** A metrics scrape observes the database now; health may reuse recent evidence.
 * Diagnostic generations identify work, independently of the returned values. */
export class DatabaseObserverCollection<T> {
  private snapshot?: {
    payload: T;
    completedAt: number;
    generation: number;
    capturedAtMs: number | null;
  };
  private collection?: Promise<T>;
  private generation = 0;
  readonly collectionInstanceId = randomUUID();
  constructor(
    private readonly read: (capture: {
      collectionGeneration: number;
      sourceKey: string;
      caller: NativeCollectionCaller;
    }) => Promise<T>,
    private readonly healthFreshnessMs: number,
    private readonly now: () => number = Date.now,
    private readonly record?: (event: EvidenceInput) => void,
    private readonly capturedAt?: (payload: T) => number | null
  ) {}
  private captureTime(payload: T): number | null {
    try {
      const time = this.capturedAt?.(payload);
      return Number.isFinite(time) && time! >= 0 ? time! : null;
    } catch {
      return null;
    }
  }
  private emit(
    outcome: EvidenceInput["outcome"],
    generation: number,
    caller: NativeCollectionCaller,
    fields: Partial<EvidenceInput> = {}
  ) {
    try {
      this.record?.({
        stage: "NATIVE_CAPTURE",
        outcome,
        scheduledAtMs: null,
        startedAtMs: null,
        finishedAtMs: null,
        availableAtMs: null,
        sourceCapturedAtMs: null,
        timestampOrigin: "UNKNOWN",
        durationMs: 0,
        queueWaitMs: 0,
        bodyReadMs: 0,
        collectionGeneration: generation,
        sourceKey: this.collectionInstanceId,
        callerRole: caller.callerRole,
        ...(caller.requestId ? { parentEventId: caller.requestId } : {}),
        ...fields
      });
    } catch {
      /* Measurement collection must survive evidence sink failure. */
    }
  }
  metrics(caller: NativeCollectionCaller = { callerRole: "UNKNOWN" }): Promise<T> {
    if (this.collection) {
      this.emit("SHARED", this.generation, caller, {
        sharedWithCollectionId: `${this.collectionInstanceId}:${this.generation}`,
        reasonCodes: ["native_in_flight"]
      });
      return this.collection;
    }
    const generation = ++this.generation,
      startedAtMs = this.now(),
      monotonicStart = performance.now();
    this.emit("STARTED", generation, caller, { startedAtMs });
    this.collection = Promise.resolve()
      .then(() =>
        this.read({
          collectionGeneration: generation,
          sourceKey: this.collectionInstanceId,
          caller
        })
      )
      .then(
        (payload) => {
          const completedAt = this.now(),
            capturedAtMs = this.captureTime(payload);
          this.snapshot = { payload, completedAt, generation, capturedAtMs };
          this.emit("SUCCEEDED", generation, caller, {
            startedAtMs,
            finishedAtMs: completedAt,
            availableAtMs: completedAt,
            sourceCapturedAtMs: capturedAtMs,
            timestampOrigin: capturedAtMs === null ? "UNKNOWN" : "SOURCE",
            durationMs: performance.now() - monotonicStart
          });
          return payload;
        },
        (error) => {
          this.emit("FAILED", generation, caller, {
            startedAtMs,
            finishedAtMs: this.now(),
            durationMs: performance.now() - monotonicStart,
            reasonCodes: ["native_capture_failed"]
          });
          throw error;
        }
      )
      .finally(() => {
        this.collection = undefined;
      });
    return this.collection;
  }
  /** Run-clock callers share one real capture in the active source interval.
   * Other callers retain request freshness; health and metrics() stay independent. */
  metricsWithEvidence(caller: NativeCollectionCaller = { callerRole: "UNKNOWN" }): Promise<{
    payload: T;
    collectionGeneration: number;
    collectionId: string;
    capturedAtMs: number | null;
  }> {
    const requestedAtMs = this.now(),
      floor =
        Number.isFinite(caller.minimumCapturedAtMs) &&
        caller.minimumCapturedAtMs! >= 0 &&
        caller.minimumCapturedAtMs! <= requestedAtMs
          ? caller.minimumCapturedAtMs
          : undefined;
    const snapshot = this.snapshot;
    if (
      floor !== undefined &&
      snapshot?.capturedAtMs !== null &&
      snapshot?.capturedAtMs !== undefined &&
      snapshot.capturedAtMs >= floor &&
      snapshot.capturedAtMs <= requestedAtMs
    ) {
      this.emit("SHARED", snapshot.generation, caller, {
        scheduledAtMs: floor,
        sharedWithCollectionId: `${this.collectionInstanceId}:${snapshot.generation}`,
        sourceCapturedAtMs: snapshot.capturedAtMs,
        timestampOrigin: "SOURCE",
        reasonCodes: ["native_current_source_interval"]
      });
      return Promise.resolve({
        payload: snapshot.payload,
        collectionGeneration: snapshot.generation,
        collectionId: `${this.collectionInstanceId}:${snapshot.generation}`,
        capturedAtMs: snapshot.capturedAtMs
      });
    }
    const wasShared = Boolean(this.collection),
      promise = this.metrics(caller),
      generation = this.generation;
    return promise.then((payload) => {
      const capturedAtMs = this.captureTime(payload);
      if (wasShared && capturedAtMs !== null && capturedAtMs < (floor ?? requestedAtMs)) {
        this.emit("SKIPPED", generation, caller, {
          sourceCapturedAtMs: capturedAtMs,
          timestampOrigin: "SOURCE",
          ...(floor === undefined ? {} : { scheduledAtMs: floor }),
          reasonCodes: [
            floor === undefined ? "capture_predates_request" : "capture_predates_source_interval"
          ]
        });
        return this.metricsWithEvidence(caller);
      }
      return {
        payload,
        collectionGeneration: generation,
        collectionId: `${this.collectionInstanceId}:${generation}`,
        capturedAtMs
      };
    });
  }
  health(caller: NativeCollectionCaller = { callerRole: "UNKNOWN" }): Promise<T> {
    if (this.collection) return this.metrics(caller);
    if (this.snapshot && this.now() - this.snapshot.completedAt < this.healthFreshnessMs) {
      this.emit("SHARED", this.snapshot.generation, caller, {
        sharedWithCollectionId: `${this.collectionInstanceId}:${this.snapshot.generation}`,
        sourceCapturedAtMs: this.snapshot.capturedAtMs,
        timestampOrigin: this.snapshot.capturedAtMs === null ? "UNKNOWN" : "SOURCE",
        reasonCodes: ["health_cache_hit"]
      });
      return Promise.resolve(this.snapshot.payload);
    }
    return this.metrics(caller);
  }
}
