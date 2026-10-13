import { api } from "../../api";
import { getComparison, getComparisonSelection } from "../../shared/control-ui-client";
import type {
  ComparisonResult,
  ComparisonRunResult
} from "../../../../../packages/contracts/src/comparison";

export interface BaselineQualitySnapshot {
  status: "accepted" | "pending" | "unavailable";
  sourceStatus?: "stable" | "pending" | "unavailable";
  reason?: string;
  run?: ComparisonRunResult;
  comparisonId: string;
  selectionRevision: number;
  baselineRunId?: string;
  generation: number;
}

export interface ComparisonLoadResult {
  comparison: ComparisonResult;
  baselineQuality: BaselineQualitySnapshot;
  retryAfterSeconds?: number;
}

export interface ComparisonLoadOptions {
  cursor?: string;
  limit?: number;
}

export type ComparisonResultFetcher = (
  id: string,
  options: ComparisonLoadOptions,
  signal?: AbortSignal
) => Promise<ComparisonResult>;

const baselineRun = (value: ComparisonResult) =>
  value.baselineRunId ? value.runs.find((run) => run.runId === value.baselineRunId) : undefined;

// Compare the quality identity provided by the contract, never rows or display names.
function observedQuality(run?: ComparisonRunResult) {
  return [
    run?.runId,
    run?.summary?.status,
    run?.summary?.attemptToken,
    run?.summary?.header?.generatedAt,
    run?.summary?.header?.metricDefinitionsVersion
  ];
}

function qualitySnapshot(
  comparison: ComparisonResult,
  generation: number,
  run = baselineRun(comparison)
): BaselineQualitySnapshot {
  const snapshot: BaselineQualitySnapshot = {
    status: "unavailable",
    sourceStatus: "unavailable",
    comparisonId: comparison.id,
    selectionRevision: comparison.selectionRevision,
    baselineRunId: comparison.baselineRunId,
    generation,
    run
  };
  if (!comparison.baselineRunId) snapshot.reason = "No baseline is selected.";
  else if (!run) snapshot.reason = "Baseline quality is unavailable. Retry comparison.";
  else if (run.summary?.status === "RECOMPUTING") {
    snapshot.status = "pending";
    snapshot.sourceStatus = "pending";
    snapshot.reason = "Baseline summary is recomputing. Available measurements remain visible.";
  } else if (
    run.summary?.status !== "READY" ||
    !run.summary.attemptToken ||
    !run.summary.header?.generatedAt ||
    !run.summary.header?.metricDefinitionsVersion
  ) {
    snapshot.reason = "Baseline source identity is incomplete or unavailable. Retry comparison.";
  } else {
    snapshot.sourceStatus = "stable";
    if (
      run.state !== "SUCCEEDED" ||
      run.measurementValidity !== "VALID" ||
      run.summary.header.quality?.complete !== true
    )
      snapshot.reason = "Baseline measurements are incomplete or ineligible for comparison.";
    else snapshot.status = "accepted";
  }
  return snapshot;
}

function retryTiming(
  comparison: ComparisonResult,
  observations: Array<ComparisonRunResult | undefined>
) {
  const waits = [comparison.retryAfterSeconds];
  for (const run of observations)
    if (run?.summary?.status === "RECOMPUTING") waits.push(run.summary.retryAfterSeconds ?? 2);
  const positive = waits.filter(
    (wait): wait is number => typeof wait === "number" && Number.isFinite(wait) && wait > 0
  );
  return positive.length ? Math.min(...positive) : undefined;
}

/** One accepted load generation; obsolete requests cannot publish or dispatch later reads. */
export class ComparisonResultLoader {
  private generation = 0;
  private controller?: AbortController;

  constructor(private fetcher: ComparisonResultFetcher = getComparison) {}

  cancel() {
    this.controller?.abort();
    this.controller = undefined;
    this.generation++;
  }

  accept(comparison: ComparisonResult): ComparisonLoadResult {
    this.cancel();
    return {
      comparison,
      baselineQuality: qualitySnapshot(comparison, this.generation),
      retryAfterSeconds: retryTiming(comparison, [baselineRun(comparison)])
    };
  }

  async load(
    id: string,
    options: ComparisonLoadOptions = {}
  ): Promise<ComparisonLoadResult | undefined> {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const current = () => generation === this.generation && !controller.signal.aborted;
    let before: ComparisonResult | undefined;
    let beforeQuality: unknown[] | undefined;
    let metadataError: unknown;
    try {
      if (options.cursor) {
        try {
          before = await this.fetcher(id, { limit: 1 }, controller.signal);
          beforeQuality = observedQuality(baselineRun(before));
        } catch (reason) {
          metadataError = reason;
        }
        if (!current()) return undefined;
      }
      const comparison = await this.fetcher(id, options, controller.signal);
      if (!current()) return undefined;
      const visibleBaseline = baselineRun(comparison);
      // The selected baseline is first on the first page. Missing first-page quality fails closed.
      if (visibleBaseline || !options.cursor || !comparison.baselineRunId)
        return {
          comparison,
          baselineQuality: qualitySnapshot(comparison, generation),
          retryAfterSeconds: retryTiming(comparison, [visibleBaseline])
        };

      let after: ComparisonResult | undefined;
      try {
        after = await this.fetcher(id, { limit: 1 }, controller.signal);
      } catch (reason) {
        metadataError ??= reason;
      }
      if (!current()) return undefined;
      const afterRun = after && baselineRun(after);
      const snapshot = qualitySnapshot(comparison, generation, afterRun);
      const sameIdentity = (value?: ComparisonResult) =>
        !!value &&
        value.id === id &&
        comparison.id === id &&
        value.selectionRevision === comparison.selectionRevision &&
        value.baselineRunId === comparison.baselineRunId;
      if (metadataError) {
        snapshot.status = "unavailable";
        snapshot.sourceStatus = "unavailable";
        snapshot.reason = `Baseline quality is unavailable: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}. Retry comparison.`;
      } else if (!sameIdentity(before) || !sameIdentity(after)) {
        snapshot.status = "unavailable";
        snapshot.sourceStatus = "unavailable";
        snapshot.reason = "Baseline selection changed while loading. Retry comparison.";
      } else if (
        !baselineRun(before!) ||
        !afterRun ||
        beforeQuality?.some((value, index) => value !== observedQuality(afterRun)[index])
      ) {
        snapshot.status = "unavailable";
        snapshot.sourceStatus = "unavailable";
        snapshot.reason = "Baseline quality changed while loading. Retry comparison.";
      }
      return {
        comparison,
        baselineQuality: snapshot,
        retryAfterSeconds: retryTiming(comparison, [before && baselineRun(before), afterRun])
      };
    } catch (reason) {
      if (!current()) return undefined;
      throw reason;
    } finally {
      if (current()) this.controller = undefined;
    }
  }
}

type Arrival = (id: string, value?: any, error?: Error) => void;
export class DetailHydrator {
  private wanted = new Set<string>();
  private queued = new Set<string>();
  private active = new Map<string, { controller: AbortController; generation: number }>();
  private generations = new Map<string, number>();
  private cache = new Map<string, any>();
  private errors = new Map<string, Error>();
  private arrival: Arrival = () => {};
  private busy: (value: boolean) => void = () => {};
  constructor(
    private fetcher = (id: string, signal: AbortSignal) =>
      api<any>(`/runs/${encodeURIComponent(id)}`, { signal })
  ) {}
  setWanted(
    ids: string[],
    arrival: Arrival,
    busy?: (value: boolean) => void,
    forceIds: string[] = []
  ) {
    this.arrival = arrival;
    this.busy = busy ?? (() => {});
    this.wanted = new Set(ids);
    for (const [id, request] of this.active)
      if (!this.wanted.has(id)) {
        request.controller.abort();
        this.generations.set(id, request.generation + 1);
      }
    for (const id of this.queued) if (!this.wanted.has(id)) this.queued.delete(id);
    for (const id of forceIds) {
      this.cache.delete(id);
      this.errors.delete(id);
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
      this.active.get(id)?.controller.abort();
    }
    for (const id of this.wanted) {
      if (this.cache.has(id)) this.arrival(id, this.cache.get(id));
      else if (this.errors.has(id)) this.arrival(id, undefined, this.errors.get(id));
      else if (!this.active.has(id) || this.active.get(id)?.controller.signal.aborted)
        this.queued.add(id);
    }
    this.drain();
  }
  private drain() {
    while (this.active.size < 4) {
      const id = [...this.queued].find((id) => !this.active.has(id));
      if (!id) break;
      this.queued.delete(id);
      if (!this.wanted.has(id)) continue;
      const request = {
        controller: new AbortController(),
        generation: this.generations.get(id) ?? 0
      };
      this.active.set(id, request);
      Promise.resolve()
        .then(() => this.fetcher(id, request.controller.signal))
        .then(
          (value) => {
            if (!this.current(id, request)) return;
            this.cache.set(id, value);
            this.arrival(id, value);
          },
          (reason) => {
            if (!this.current(id, request)) return;
            const error = reason instanceof Error ? reason : new Error(String(reason));
            this.errors.set(id, error);
            this.arrival(id, undefined, error);
          }
        )
        .finally(() => {
          this.active.delete(id);
          this.drain();
        });
    }
    this.busy([...this.active.keys(), ...this.queued].some((id) => this.wanted.has(id)));
  }
  private current(id: string, request: { controller: AbortController; generation: number }) {
    return (
      this.wanted.has(id) &&
      !request.controller.signal.aborted &&
      request.generation === (this.generations.get(id) ?? 0)
    );
  }
  cancel() {
    this.wanted.clear();
    this.queued.clear();
    for (const request of this.active.values()) request.controller.abort();
  }
}

export async function restoreComparisonSelection(
  id: string,
  clients: {
    result: (id: string) => Promise<any>;
    selection: (id: string, options: { cursor?: string; limit?: number }) => Promise<any>;
  } = { result: getComparison, selection: getComparisonSelection }
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const comparison = await clients.result(id),
        runIds: string[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const value = await clients.selection(id, { cursor, limit: 100 });
        if (value.selectionRevision !== comparison.selectionRevision)
          throw Object.assign(new Error("Selection changed"), {
            code: "comparison_selection_cursor_stale"
          });
        for (const runId of value.selectionPage.runIds)
          if (!seen.has(runId)) {
            seen.add(runId);
            runIds.push(runId);
          }
        if (!value.selectionPage.hasMore) break;
        cursor = value.selectionPage.nextCursor;
        if (!cursor || cursors.has(cursor))
          throw new Error("Saved selection pagination is incomplete");
        cursors.add(cursor);
      } while (true);
      if (
        comparison.totalSelectedRunCount !== undefined &&
        comparison.totalSelectedRunCount !== runIds.length
      )
        throw new Error("Saved selection is incomplete");
      return { comparison, runIds };
    } catch (reason) {
      if ((reason as any).code !== "comparison_selection_cursor_stale" || attempt === 2)
        throw reason;
    }
  }
  throw new Error("Saved selection kept changing. Retry opening the comparison.");
}

import {
  COMPARISON_METRIC_SELECTION_VERSION,
  validateMetricSelectionResponse,
  selectionIdentity,
  type MetricSelection,
  type MetricSelectionRequest,
  type MetricSelectionResponse,
  type ProjectedMetricValue
} from "../../../../../packages/contracts/src/comparison-metric-selection";
export type MetricValuesFetcher = (
  id: string,
  request: MetricSelectionRequest,
  signal: AbortSignal
) => Promise<MetricSelectionResponse>;
/** Definition batches are independent of row pages. Further table pages are fetched explicitly. */
export class MetricValuesLoader {
  private generation = 0;
  private controller?: AbortController;
  private comparisonId = "";
  private revision = 0;
  private runIds: string[] = [];
  private batches: Array<{ metrics: MetricSelection[]; cursor?: string; done: boolean }> = [];
  private rows = new Map<string, ProjectedMetricValue>();
  private identity?: string;
  constructor(
    private fetcher: MetricValuesFetcher = (id, request, signal) =>
      api(`/comparisons/${encodeURIComponent(id)}/metric-values`, {
        method: "POST",
        body: JSON.stringify(request),
        signal
      })
  ) {}
  cancel() {
    this.controller?.abort();
    this.generation++;
    this.batches = [];
    this.rows.clear();
  }
  async load(id: string, revision: number, runIds: string[], metrics: MetricSelection[]) {
    this.cancel();
    this.comparisonId = id;
    this.revision = revision;
    this.runIds = runIds;
    this.identity = undefined;
    if (metrics.length > 256) throw new Error("Metric selection exceeds 256 entries.");
    for (let i = 0; i < metrics.length; i += 32)
      this.batches.push({ metrics: metrics.slice(i, i + 32), done: false });
    return this.next();
  }
  async next() {
    const generation = this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const current = () => generation === this.generation && !controller.signal.aborted;
    try {
      for (const batch of this.batches) {
        if (batch.done) continue;
        const request: MetricSelectionRequest = {
          contractVersion: COMPARISON_METRIC_SELECTION_VERSION,
          selectionRevision: this.revision,
          runIds: this.runIds,
          metrics: batch.metrics,
          limit: 100,
          ...(batch.cursor ? { cursor: batch.cursor } : {})
        };
        const response = await this.fetcher(this.comparisonId, request, controller.signal);
        if (!current()) return undefined;
        validateMetricSelectionResponse(response);
        if (
          response.comparisonId !== this.comparisonId ||
          response.selectionRevision !== this.revision ||
          response.selectionIdentity !== selectionIdentity(batch.metrics) ||
          (this.identity && this.identity !== response.sourceIdentity)
        )
          throw new Error(
            "Comparison measurements changed while loading selected metrics. Refresh comparison."
          );
        this.identity = response.sourceIdentity;
        for (const row of response.rows) {
          if (
            !this.runIds.includes(row.runId) ||
            !batch.metrics.some(
              (m) => m.metricId === row.metricId && m.statistics.includes(row.statistic)
            )
          )
            throw new Error("comparison_metric_response_identity_invalid");
          this.rows.set(row.rowId, row);
        }
        if (
          new TextEncoder().encode(JSON.stringify([...this.rows.values()])).length >
          32 * 1024 * 1024
        )
          throw new Error(
            "Selected metric display exceeds 32 MiB. Narrow table or scope selectors."
          );
        if (response.hasMore && (!response.nextCursor || response.nextCursor === batch.cursor))
          throw new Error("Selected metric pagination is incomplete.");
        batch.done = !response.hasMore;
        batch.cursor = response.nextCursor;
      }
      return { rows: [...this.rows.values()], hasMore: this.batches.some((b) => !b.done) };
    } catch (error) {
      if (!current()) return undefined;
      throw error;
    }
  }
}
