import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { QueryEvidence } from "../../contracts/src/measurement-diagnostics";
import { validateMeasurementEvidence } from "../../contracts/src/measurement-diagnostics";
import type { SummaryRow, Coverage } from "../../contracts/src/metric-definitions";
import type { MetricSample } from "../../contracts/src/metrics";
export interface DiagnosticSelector {
  contractVersion: "measurement-query-selector.v1";
  metricName: string;
  matchers: Array<{ name: string; operator: string; value: string }>;
  runIds: string[];
  source: string;
}
export interface ProjectionEvidence {
  contractVersion: "measurement-projection.v1";
  projectionStage: "CALCULATED" | "STAGED" | "COMPARISON";
  definitionId: string;
  group: string;
  dimensions: Record<string, string>;
  statistic: string;
  status: string;
  reasonCodes: string[];
  supportedSeconds: number | null;
  estimatedSeconds: number | null;
  missingSeconds: number | null;
  availableBins: number | null;
  omittedBins: number | null;
  expectedAcquisitions: number | null;
  observedAcquisitions: number | null;
  minimumPercentileBins: number;
  sourceReferences: Array<{ metric?: string; contractVersion?: string }>;
}
export interface StatisticsDecisionEvidence {
  contractVersion: "measurement-statistics-decision.v1";
  startMs: number;
  endMs: number;
  cadenceMs: number;
  physicalId: string | null;
  storedObservations: number;
  reasonCodes: string[];
  counts: Record<string, number>;
  scope?: Coverage["constituentSelector"];
}
export interface QueryEvidenceContext {
  runId: string;
  runIds: string[];
  diagnosticAttemptId: string;
  consumer: QueryEvidence["consumer"];
  source: string;
  definitionId: string;
  semanticVersion: string;
  dimensions: Record<string, string>;
  expectedMemberIds: string[];
  expectationRefs: string[];
  requestedStartMs: number;
  requestedEndMs: number;
  nativeCadenceMs: number | null;
  scrapeCadenceMs: number | null;
  lookbackMs: number | null;
  transforms: string[];
  counterEdgePolicy: string | null;
  summaryAttemptId?: string;
  parentQueryId?: string;
  modeOverride?: QueryEvidence["mode"];
  instantEffectiveWindow?: { startMs: number; endMs: number };
  recordChunk?(metadata: {
    requestedStartMs: number;
    requestedEndMs: number;
    effectiveStartMs: number;
    effectiveEndMs: number;
    returnedSamples: number;
    retainedSamples: number;
    duplicateSeamSamples: number;
    cadenceMs: number;
  }): void;
  reportLoss?(reasonCode: string): void;
  /** Awaited only at existing asynchronous finalization/audit boundaries. */
  flush?(): Promise<void>;
  resolveExpectedMembers?(source: string, group: string): string[];
  recordProjection?(evidence: ProjectionEvidence): void;
  recordStatistics?(evidence: StatisticsDecisionEvidence): void;
  recordCache?(metadata: {
    runId: string;
    summaryAttemptId: string | null;
    version: string;
    cache: "HIT" | "MISS";
    publicationOutcome: string | null;
  }): void;
  record(evidence: QueryEvidence): void;
  registerSelector?(selector: DiagnosticSelector): string;
}
const contexts = new AsyncLocalStorage<QueryEvidenceContext>();
export function withQueryEvidence<T>(context: QueryEvidenceContext, task: () => T): T {
  return contexts.run(context, task);
}
export function currentQueryEvidence() {
  return contexts.getStore();
}
export function withQueryEvidenceOverrides<T>(
  overrides: Partial<QueryEvidenceContext>,
  task: () => T
): T {
  const parent = currentQueryEvidence();
  return parent ? contexts.run({ ...parent, ...overrides }, task) : task();
}
export async function flushQueryEvidence(): Promise<void> {
  const context = currentQueryEvidence();
  try {
    await context?.flush?.();
  } catch {
    try {
      context?.reportLoss?.("query_evidence_flush_failed");
    } catch {}
  }
}
export function recordProjectionMetadata(
  row: SummaryRow,
  projectionStage: ProjectionEvidence["projectionStage"] = "CALCULATED"
) {
  const context = currentQueryEvidence();
  if (!context?.recordProjection) return;
  try {
    for (const [statistic, value] of Object.entries(row.statistics)) {
      const coverage = value.coverage ?? row.coverage;
      context.recordProjection({
        contractVersion: "measurement-projection.v1",
        projectionStage,
        definitionId: row.definitionId,
        group: row.group,
        dimensions: row.dimensions,
        statistic,
        status: value.status,
        reasonCodes: [...new Set([...(value.reasons ?? []), ...(coverage.reasons ?? [])])],
        supportedSeconds: coverage.observedSeconds,
        estimatedSeconds: coverage.estimatedEdgeSeconds,
        missingSeconds: coverage.missingSeconds,
        availableBins: coverage.percentileBinCount,
        omittedBins: coverage.omittedBinCount,
        expectedAcquisitions: coverage.expectedAcquisitions,
        observedAcquisitions: coverage.observedAcquisitions,
        minimumPercentileBins: 2,
        sourceReferences: row.sourceReferences.map((ref) => ({
          metric: ref.metric,
          contractVersion: ref.contractVersion
        }))
      });
    }
  } catch {
    try {
      context.reportLoss?.("projection_evidence_failed");
    } catch {}
  }
}
const labelNames = new Set([
  "job",
  "run_id",
  "experiment_id",
  "variant_id",
  "repetition",
  "phase",
  "id",
  "container_id",
  "name",
  "container",
  "service",
  "replica",
  "pool",
  "table",
  "table_number",
  "index",
  "direction",
  "operation",
  "file",
  "scope",
  "device",
  "interface",
  "source",
  "component",
  "database_epoch",
  "measurement",
  "family",
  "availability",
  "reason",
  "database_name",
  "latch_name",
  "latch_number",
  "schema_version",
  "container_label_com_docker_compose_project",
  "container_label_com_docker_compose_service",
  "container_label_parkbench_run_id",
  "container_label_parkbench_managed"
]);
/** Only generated selector grammar and known identity labels can be retained.
 * Arbitrary PromQL is deliberately not copied from a caller's expression. */
export function validateDiagnosticSelector(
  selector: string,
  runIds: string[],
  source: string
): DiagnosticSelector | undefined {
  if (selector.length > 4096 || !runIds.length || runIds.length > 128) return;
  const parsed = selector.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?$/);
  if (!parsed || parsed[1].length > 256) return;
  const matchers: DiagnosticSelector["matchers"] = [];
  let remaining = parsed[2] ?? "";
  if (remaining.endsWith(",")) return;
  while (remaining) {
    const match = remaining.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*)(=~|!~|!=|=)"((?:\\.|[^"\\])*)"(?:,|$)/
    );
    if (
      !match ||
      !labelNames.has(match[1]) ||
      matchers.length >= 32 ||
      match[3].length > 256 ||
      matchers.some((m) => m.name === match[1])
    )
      return;
    let value: string;
    try {
      value = JSON.parse(`"${match[3]}"`);
    } catch {
      return;
    }
    matchers.push({ name: match[1], operator: match[2], value });
    remaining = remaining.slice(match[0].length);
  }
  const run = matchers.find((m) => m.name === "run_id");
  const publisher = matchers.find((m) => m.name === "job");
  if (
    run
      ? run.operator !== "=" || !runIds.includes(run.value)
      : !(source === "cadvisor" && publisher?.operator === "=" && publisher.value === "cadvisor")
  )
    return;
  return {
    contractVersion: "measurement-query-selector.v1",
    metricName: parsed[1],
    matchers,
    runIds: [...runIds],
    source
  };
}
export interface ResponseReadEvidence {
  responseBytes: number;
  bodyReadMs: number;
  seriesCount: number;
  sampleCount: number;
  complete: boolean;
}
export class QueryEvidenceSpan {
  private readonly queryId = randomUUID();
  private readonly entered = performance.now();
  private dispatched?: number;
  private read?: ResponseReadEvidence;
  private selectorRef = "unrecorded-selector";
  private incomplete = false;
  private ended = false;
  constructor(
    private context: QueryEvidenceContext,
    private mode: QueryEvidence["mode"],
    query: string,
    private start: number,
    private end: number,
    private step: number | null
  ) {
    const selector = validateDiagnosticSelector(query, context.runIds, context.source);
    try {
      if (selector && context.registerSelector)
        this.selectorRef = context.registerSelector(selector);
      else this.incomplete = true;
    } catch {
      this.incomplete = true;
    }
  }
  dispatch() {
    this.dispatched = performance.now();
  }
  body = (evidence: ResponseReadEvidence) => {
    this.read = evidence;
  };
  finish(samples: MetricSample[], error?: unknown) {
    if (this.ended) return;
    this.ended = true;
    try {
      const matched = new Set<string>();
      let min: number | null = null,
        max: number | null = null;
      for (const sample of samples) {
        min = Math.min(min ?? Infinity, sample.timestamp * 1000);
        max = Math.max(max ?? -Infinity, sample.timestamp * 1000);
        for (const identity of [
          sample.labels.id,
          sample.labels.container_id,
          sample.labels.service,
          sample.labels.replica,
          sample.labels.container_label_com_docker_compose_service
        ]) {
          if (!identity) continue;
          const dockerId = identity.match(/(?:^|[/:_-])([a-f0-9]{64})(?:\.scope)?$/)?.[1];
          const physicalId = dockerId ?? identity;
          if (this.context.expectedMemberIds.includes(physicalId)) matched.add(physicalId);
        }
      }
      if (this.mode === "EVALUATION_GRID") {
        min = null;
        max = null;
      }
      const missing = this.context.expectedMemberIds.filter((id) => !matched.has(id));
      const reasonCodes = ["counter_semantics_not_assessed_at_query_stage"];
      if (this.mode === "EVALUATION_GRID")
        reasonCodes.push(
          "evaluation_points_are_not_acquisitions",
          "source_timestamp_unavailable_in_evaluation_grid"
        );
      if (missing.length) reasonCodes.push("required_member_missing");
      if (this.incomplete) reasonCodes.push("selector_reference_unavailable");
      if (error) reasonCodes.push("query_failed");
      const outcome = !error
        ? "SUCCEEDED"
        : (error as Error)?.name === "AbortError"
          ? "CANCELLED"
          : (error as Error)?.name === "TimeoutError" ||
              (error as Error)?.message === "query_timeout"
            ? "TIMED_OUT"
            : "FAILED";
      const evidence = validateMeasurementEvidence<QueryEvidence>({
        contractVersion: "measurement-query-evidence.v1",
        runId: this.context.runId,
        diagnosticAttemptId: this.context.diagnosticAttemptId,
        queryId: this.queryId,
        ...(this.context.parentQueryId ? { parentQueryId: this.context.parentQueryId } : {}),
        ...(this.context.summaryAttemptId
          ? { summaryAttemptId: this.context.summaryAttemptId }
          : {}),
        consumer: this.context.consumer,
        mode: this.mode,
        runIds: this.context.runIds,
        source: this.context.source,
        definitionId: this.context.definitionId,
        semanticVersion: this.context.semanticVersion,
        dimensions: this.context.dimensions,
        expectedMemberIds: this.context.expectedMemberIds,
        selectorRef: this.selectorRef,
        expectationRefs: this.context.expectationRefs,
        requestedStartMs: this.context.requestedStartMs,
        requestedEndMs: this.context.requestedEndMs,
        effectiveStartMs: this.start * 1000,
        effectiveEndMs: this.end * 1000,
        stepMs: this.step === null ? null : this.step * 1000,
        nativeCadenceMs: this.context.nativeCadenceMs,
        scrapeCadenceMs: this.context.scrapeCadenceMs,
        lookbackMs: this.context.lookbackMs,
        transforms: this.context.transforms,
        counterEdgePolicy: this.context.counterEdgePolicy,
        queueWaitMs: Math.max(0, (this.dispatched ?? performance.now()) - this.entered),
        durationMs: Math.max(0, performance.now() - (this.dispatched ?? this.entered)),
        bodyReadMs: this.read?.bodyReadMs ?? 0,
        requestCount: this.dispatched === undefined ? 0 : 1,
        pageCount: 1,
        responseBytes: this.read?.responseBytes ?? 0,
        outcome,
        retryLevel: 0,
        seriesCount: this.read?.seriesCount ?? 0,
        memberCount: matched.size,
        sampleCount: samples.length,
        sourceTimestampMinMs: min,
        sourceTimestampMaxMs: max,
        duplicateCount: 0,
        conflictCount: 0,
        resetCount: 0,
        epochCount: 0,
        reasonCodes,
        missingMemberIds: missing,
        projections: [],
        cache: "NONE",
        publicationOutcome: null,
        inventoryIncomplete: this.incomplete || Boolean(error) || !this.read?.complete
      });
      this.context.record(evidence);
    } catch {
      try {
        this.context.reportLoss?.("query_evidence_invalid_or_unavailable");
      } catch {
        /* Operational sink failure must not fail measurement. */
      }
    }
  }
}
export function startQueryEvidence(
  mode: QueryEvidence["mode"],
  query: string,
  start: number,
  end: number,
  step: number | null = null
): QueryEvidenceSpan | undefined {
  const context = currentQueryEvidence();
  if (!context) return;
  try {
    return new QueryEvidenceSpan(context, context.modeOverride ?? mode, query, start, end, step);
  } catch {
    try {
      context.reportLoss?.("query_evidence_start_failed");
    } catch {}
    return;
  }
}

export function recordComparisonProjectionMetadata(input: {
  definitionId: string;
  group: string;
  dimensions: Record<string, string>;
  statistic: string;
  status: string;
  reasonCodes: string[];
  coverage?: Coverage;
  sourceReferences?: Array<{ metric?: string; contractVersion?: string }>;
}) {
  const context = currentQueryEvidence();
  if (!context?.recordProjection) return;
  try {
    const coverage = input.coverage;
    context.recordProjection({
      contractVersion: "measurement-projection.v1",
      projectionStage: "COMPARISON",
      definitionId: input.definitionId,
      group: input.group,
      dimensions: input.dimensions,
      statistic: input.statistic,
      status: input.status,
      reasonCodes: [...new Set([...input.reasonCodes, ...(coverage?.reasons ?? [])])],
      supportedSeconds: coverage?.observedSeconds ?? null,
      estimatedSeconds: coverage?.estimatedEdgeSeconds ?? null,
      missingSeconds: coverage?.missingSeconds ?? null,
      availableBins: coverage?.percentileBinCount ?? null,
      omittedBins: coverage?.omittedBinCount ?? null,
      expectedAcquisitions: coverage?.expectedAcquisitions ?? null,
      observedAcquisitions: coverage?.observedAcquisitions ?? null,
      minimumPercentileBins: 2,
      sourceReferences: (input.sourceReferences ?? []).map((ref) => ({
        metric: ref.metric,
        contractVersion: ref.contractVersion
      }))
    });
  } catch {
    try {
      context.reportLoss?.("comparison_projection_evidence_failed");
    } catch {}
  }
}
