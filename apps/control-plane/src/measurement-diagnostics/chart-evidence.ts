import { redactSecrets } from "../../../../packages/contracts/src/redaction";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
export interface ChartDecision {
  stage:
    | "UPSTREAM"
    | "NATIVE_SOURCE"
    | "NATIVE_COUNTER"
    | "PHASE_FILTER"
    | "SAVED_SUMMARY"
    | "ALIGNMENT";
  outcome: "SUCCEEDED" | "REJECTED" | "UNAVAILABLE";
  runId?: string;
  requestedStartMs?: number;
  requestedEndMs?: number;
  effectiveStartMs?: number;
  effectiveEndMs?: number;
  stepMs?: number;
  cadenceMs?: number;
  lookbackMs?: number;
  shiftMs?: number;
  sourceTimestampMinMs?: number | null;
  sourceTimestampMaxMs?: number | null;
  counts?: Record<string, number>;
  reasonCodes: string[];
}
export interface ChartQueryEvidence {
  contractVersion: "measurement-chart-query.v1";
  queryId: string;
  runIds: string[];
  mode: string;
  queryMode: "EVALUATION_GRID" | "NATIVE_COUNTER_WINDOW" | "SAVED_SUMMARY";
  requestedStartMs: number;
  requestedEndMs: number;
  stepMs: number | null;
  durationMs: number;
  seriesCount: number;
  evaluationPointCount: number;
  decisions: Array<ChartDecision & { eventCount: number }>;
  incomplete: boolean;
  droppedDecisionKinds: number;
}
class ChartCapture {
  readonly decisions = new Map<string, ChartDecision & { eventCount: number }>();
  dropped = 0;
  record(input: ChartDecision) {
    const key = `${input.stage}:${input.outcome}:${input.runId ?? ""}`;
    const previous = this.decisions.get(key);
    if (!previous && this.decisions.size >= 8) {
      this.dropped++;
      return;
    }
    if (
      input.reasonCodes.length > 8 ||
      input.reasonCodes.some((code) => code.length > 128) ||
      Object.keys(input.counts ?? {}).length > 16
    ) {
      this.dropped++;
      return;
    }
    if (!previous) {
      this.decisions.set(key, {
        ...input,
        counts: input.counts ? { ...input.counts } : undefined,
        reasonCodes: [...input.reasonCodes],
        eventCount: 1
      });
      return;
    }
    previous.eventCount++;
    // These are explicit envelopes of repeated decisions, never fabricated samples.
    for (const field of ["effectiveStartMs", "sourceTimestampMinMs"] as const)
      if (input[field] != null)
        previous[field] = Math.min(previous[field] ?? Infinity, input[field]!);
    for (const field of ["effectiveEndMs", "sourceTimestampMaxMs"] as const)
      if (input[field] != null)
        previous[field] = Math.max(previous[field] ?? -Infinity, input[field]!);
    for (const [name, value] of Object.entries(input.counts ?? {})) {
      if (
        !Object.hasOwn(previous.counts ?? {}, name) &&
        Object.keys(previous.counts ?? {}).length >= 16
      ) {
        this.dropped++;
        continue;
      }
      previous.counts ??= {};
      previous.counts[name] = (previous.counts[name] ?? 0) + value;
    }
    for (const reason of input.reasonCodes)
      if (!previous.reasonCodes.includes(reason)) {
        if (previous.reasonCodes.length < 8) previous.reasonCodes.push(reason);
        else this.dropped++;
      }
  }
}
const captures = new AsyncLocalStorage<ChartCapture>();
export function recordChartDecision(input: ChartDecision) {
  try {
    captures.getStore()?.record(input);
  } catch {
    const capture = captures.getStore();
    if (capture) capture.dropped++;
  }
}
export async function captureChartEvidence<T>(task: () => Promise<T>) {
  const capture = new ChartCapture(),
    started = performance.now();
  const result = await captures.run(capture, task);
  return {
    result,
    queryId: randomUUID(),
    durationMs: performance.now() - started,
    decisions: [...capture.decisions.values()],
    incomplete: capture.dropped > 0,
    droppedDecisionKinds: capture.dropped
  };
}
export function boundedChartHeader(evidence: ChartQueryEvidence, secrets: string[] = []): string {
  const safe = redactSecrets(evidence, secrets) as ChartQueryEvidence;
  if (JSON.stringify(safe) !== JSON.stringify(evidence)) safe.incomplete = true;
  let data = Buffer.from(JSON.stringify(safe)).toString("base64url");
  if (Buffer.byteLength(data) > 4096)
    data = Buffer.from(
      JSON.stringify({
        ...safe,
        decisions: [],
        incomplete: true,
        droppedDecisionKinds: safe.droppedDecisionKinds + safe.decisions.length
      })
    ).toString("base64url");
  if (Buffer.byteLength(data) > 4096)
    data = Buffer.from(
      JSON.stringify({
        ...safe,
        runIds: [],
        decisions: [],
        incomplete: true,
        droppedDecisionKinds: safe.droppedDecisionKinds + safe.decisions.length
      })
    ).toString("base64url");
  return data;
}
