import { randomUUID } from "node:crypto";
import { NATIVE_FAILURE_CODES, NativeProcessFailure } from "./failure-metadata";

interface FailureRecord extends NativeProcessFailure {
  stage: "PROCESS" | "NORMALIZE";
  collectionGeneration: number;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
}
interface StageEvent {
  stage: "PROCESS" | "NORMALIZE";
  outcome: "SUCCEEDED" | "FAILED";
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  failure?: NativeProcessFailure;
}
interface ExpositionTiming {
  callerRole: "CONTROLLER" | "SCRAPER" | "UNKNOWN";
  requestedAtMs: number;
  finishedAtMs: number;
  minimumCapturedAtMs: number | null;
  collectionGeneration: number | null;
  sourceCapturedAtMs: number | null;
  httpStatus: number;
}
type TimingEvent = Record<string, string | number | null>;
const timestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/** Volatile bounded operational status, including when callback recording is off.
 * It never stores child output, arguments, requests or measurement values. */
export class NativeCaptureStatus {
  private readonly componentInstanceId = randomUUID();
  private sourceKey: string | null = null;
  private failureCount = 0;
  private droppedFailures = 0;
  private rejectedFailureMetadata = 0;
  private failures: FailureRecord[] = [];
  private timingEventCount = 0;
  private droppedTimingEvents = 0;
  private rejectedTimingEvents = 0;
  private timingBytes = 0;
  private timingEvents: Array<{ event: TimingEvent; bytes: number }> = [];
  constructor(private readonly runId: string) {}

  observe(capture: { sourceKey: string; collectionGeneration: number }, event: StageEvent): void {
    if (
      typeof capture.sourceKey !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(capture.sourceKey)
    ) {
      this.rejectedFailureMetadata++;
      return;
    }
    this.sourceKey ??= capture.sourceKey;
    if (
      this.timingCaptureValid(capture) &&
      ["PROCESS", "NORMALIZE"].includes(event.stage) &&
      ["SUCCEEDED", "FAILED"].includes(event.outcome) &&
      timestamp(event.startedAtMs) &&
      timestamp(event.finishedAtMs) &&
      event.finishedAtMs >= event.startedAtMs &&
      Number.isFinite(event.durationMs) &&
      event.durationMs >= 0
    ) {
      this.appendTiming({
        stage: event.stage,
        outcome: event.outcome,
        collectionGeneration: capture.collectionGeneration,
        startedAtMs: event.startedAtMs,
        finishedAtMs: event.finishedAtMs,
        durationMs: event.durationMs
      });
    } else this.rejectedTimingEvents++;
    if (event.outcome !== "FAILED") return;
    this.failureCount++;
    const f = event.failure;
    if (
      !f ||
      !NATIVE_FAILURE_CODES.includes(f.code) ||
      !(f.exitCode === null || Number.isSafeInteger(f.exitCode)) ||
      ![null, "SIGKILL", "SIGTERM", "OTHER"].includes(f.signal) ||
      !["NONE", "INVALID", "VALID"].includes(f.outputState) ||
      !Number.isSafeInteger(f.outputBytes) ||
      f.outputBytes < 0 ||
      !(f.sourceCapturedAtMs === null || Number.isSafeInteger(f.sourceCapturedAtMs)) ||
      !Number.isSafeInteger(capture.collectionGeneration) ||
      capture.collectionGeneration < 1 ||
      !Number.isSafeInteger(event.startedAtMs) ||
      !Number.isSafeInteger(event.finishedAtMs) ||
      event.finishedAtMs < event.startedAtMs ||
      !Number.isFinite(event.durationMs) ||
      event.durationMs < 0 ||
      !["PROCESS", "NORMALIZE"].includes(event.stage) ||
      capture.sourceKey !== this.sourceKey
    ) {
      this.rejectedFailureMetadata++;
      return;
    }
    this.failures.push({
      stage: event.stage,
      collectionGeneration: capture.collectionGeneration,
      startedAtMs: event.startedAtMs,
      finishedAtMs: event.finishedAtMs,
      durationMs: event.durationMs,
      code: f.code,
      exitCode: f.exitCode,
      signal: f.signal,
      outputState: f.outputState,
      outputBytes: f.outputBytes,
      sourceCapturedAtMs: f.sourceCapturedAtMs
    });
    if (this.failures.length > 64) {
      this.failures.shift();
      this.droppedFailures++;
    }
  }
  private timingCaptureValid(capture: { sourceKey: string; collectionGeneration: number }) {
    return (
      typeof capture.sourceKey === "string" &&
      /^[a-zA-Z0-9_.-]{1,128}$/.test(capture.sourceKey) &&
      capture.sourceKey === this.sourceKey &&
      Number.isSafeInteger(capture.collectionGeneration) &&
      capture.collectionGeneration > 0
    );
  }
  private appendTiming(fields: TimingEvent) {
    const event = { sequence: ++this.timingEventCount, ...fields };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.timingEvents.push({ event, bytes });
    this.timingBytes += bytes;
    while (this.timingEvents.length > 512 || this.timingBytes > 120 * 1024) {
      this.timingBytes -= this.timingEvents.shift()!.bytes;
      this.droppedTimingEvents++;
    }
  }
  captureCompleted(
    capture: { sourceKey: string; collectionGeneration: number },
    sourceCapturedAtMs: number,
    finishedAtMs = Date.now()
  ) {
    if (
      !this.timingCaptureValid(capture) ||
      !timestamp(sourceCapturedAtMs) ||
      !timestamp(finishedAtMs) ||
      sourceCapturedAtMs > finishedAtMs
    ) {
      this.rejectedTimingEvents++;
      return;
    }
    this.appendTiming({
      stage: "CAPTURE",
      collectionGeneration: capture.collectionGeneration,
      sourceCapturedAtMs,
      finishedAtMs
    });
  }
  exposition(event: ExpositionTiming) {
    if (
      !["CONTROLLER", "SCRAPER", "UNKNOWN"].includes(event.callerRole) ||
      !timestamp(event.requestedAtMs) ||
      !timestamp(event.finishedAtMs) ||
      event.finishedAtMs < event.requestedAtMs ||
      !(
        event.minimumCapturedAtMs === null ||
        (timestamp(event.minimumCapturedAtMs) && event.minimumCapturedAtMs <= event.requestedAtMs)
      ) ||
      !(
        event.collectionGeneration === null ||
        (Number.isSafeInteger(event.collectionGeneration) && event.collectionGeneration > 0)
      ) ||
      !(event.sourceCapturedAtMs === null || timestamp(event.sourceCapturedAtMs)) ||
      !Number.isSafeInteger(event.httpStatus) ||
      event.httpStatus < 100 ||
      event.httpStatus > 599
    ) {
      this.rejectedTimingEvents++;
      return;
    }
    this.appendTiming({
      stage: "EXPOSITION",
      callerRole: event.callerRole,
      requestedAtMs: event.requestedAtMs,
      finishedAtMs: event.finishedAtMs,
      minimumCapturedAtMs: event.minimumCapturedAtMs,
      collectionGeneration: event.collectionGeneration,
      sourceCapturedAtMs: event.sourceCapturedAtMs,
      httpStatus: event.httpStatus
    });
  }
  timingSnapshot() {
    return {
      contractVersion: "measurement-native-capture-timing.v1",
      runId: this.runId,
      componentInstanceId: this.componentInstanceId,
      collectionSourceKey: this.sourceKey,
      eventCount: this.timingEventCount,
      retainedEventCount: this.timingEvents.length,
      droppedEvents: this.droppedTimingEvents,
      rejectedEvents: this.rejectedTimingEvents,
      historyComplete: this.droppedTimingEvents === 0 && this.rejectedTimingEvents === 0,
      events: this.timingEvents.map(({ event }) => ({ ...event }))
    };
  }
  snapshot() {
    return {
      contractVersion: "measurement-native-capture-status.v1",
      runId: this.runId,
      componentInstanceId: this.componentInstanceId,
      collectionSourceKey: this.sourceKey,
      failureCount: this.failureCount,
      retainedFailureCount: this.failures.length,
      droppedFailures: this.droppedFailures,
      rejectedFailureMetadata: this.rejectedFailureMetadata,
      historyComplete: this.droppedFailures === 0 && this.rejectedFailureMetadata === 0,
      failures: this.failures.map((record) => ({ ...record }))
    };
  }
}
