import { NativeQueryBudget } from "../grafana/native-query-budget";
import { createHash } from "node:crypto";
import type {
  ComparisonSelection,
  SummaryReader,
  SummaryReadResult
} from "../../../../packages/contracts/src/comparison";
import type { Run } from "../../../../packages/contracts/src/run";
import type { SummaryRow } from "../../../../packages/contracts/src/metric-definitions";
import {
  COMPARISON_METRIC_CATALOG,
  COMPARISON_METRIC_SELECTION_VERSION,
  validateMetricSelectionRequest,
  selectionIdentity,
  numericDifference,
  type ComparisonMetricDescriptor,
  type MetricSelection,
  type MetricSelectionRequest,
  type MetricSelectionResponse,
  type ProjectedMetricValue
} from "../../../../packages/contracts/src/comparison-metric-selection";
import { selectedRunIds } from "./service";
export type NativeProjection = (
  run: Run,
  summary: SummaryReadResult,
  metric: MetricSelection,
  signal?: AbortSignal,
  budget?: NativeQueryBudget
) => Promise<
  Array<{
    dimensions: Record<string, string>;
    value: number | null;
    reasons: string[];
    sourceReferences: unknown[];
  }>
>;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const unavailable = (reason: string) => ({
  value: null,
  availability: "unavailable" as const,
  reasons: [reason],
  sourceReferences: []
});
function warning(run: Run, summary: SummaryReadResult, baseline = false): string[] {
  return run.state !== "SUCCEEDED" ||
    run.measurementValidity !== "VALID" ||
    summary.header?.quality.complete !== true
    ? [`${baseline ? "Baseline" : "Run"} measurements are incomplete or ineligible for comparison.`]
    : [];
}
function snapshot(reader: SummaryReader, run: Run) {
  const s = reader.read(run.id);
  return {
    summary: s,
    identity: hash([
      run.id,
      run.state,
      run.measurementValidity,
      s.status,
      s.attemptToken,
      s.header?.generatedAt,
      s.header?.metricDefinitionsVersion,
      s.header?.windows,
      s.header?.quality,
      (run.environmentSnapshot as any)?.namedLatchInventories
    ])
  };
}
function stableSummary(run: Run, s: SummaryReadResult): boolean {
  return (
    s.status === "READY" &&
    !!s.attemptToken &&
    !!s.header?.generatedAt &&
    !!s.header?.metricDefinitionsVersion &&
    s.header?.run.id === run.id
  );
}
function workloadValue(run: Run, summary: SummaryReadResult, d: ComparisonMetricDescriptor) {
  const w = summary.header?.workload as any,
    seconds = summary.header?.windows.measurement.durationSeconds;
  if (summary.header?.run.id !== run.id || w?.runId !== run.id)
    return unavailable("workload_owner_or_data_unavailable");
  const id = d.metricId.slice("workload.".length);
  let value: unknown;
  if (id === "completed.rate")
    value =
      seconds && seconds > 0 && typeof w.requests?.completed === "number"
        ? w.requests.completed / seconds
        : null;
  else if (id.startsWith("latency."))
    value =
      typeof w.latencySeconds?.count === "number" && w.latencySeconds.count > 0
        ? w.latencySeconds[id.slice(8)]
        : null;
  else value = id === "timeouts" ? w.timeoutCount : w.requests?.[id];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return unavailable(
      id.startsWith("latency.") ? "no_latency_observations" : "workload_statistic_unavailable"
    );
  return {
    value,
    availability: "available" as const,
    reasons: [],
    sourceReferences: [{ source: "saved_summary", path: `workload.${id}` }]
  };
}
interface Position {
  run: number;
  metric: number;
  cursor?: string;
  row: number;
  stat: number;
  seen: boolean;
}
const initial = (): Position => ({ run: 0, metric: 0, row: 0, stat: 0, seen: false });
export function createMetricSelectionService(deps: {
  reader: SummaryReader;
  lookup: (id: string) => Run | undefined;
  nativeProjection?: NativeProjection;
}) {
  return async (
    selection: ComparisonSelection,
    input: unknown,
    options: { signal?: AbortSignal } = {}
  ): Promise<MetricSelectionResponse> => {
    validateMetricSelectionRequest(input);
    const request = input as MetricSelectionRequest;
    if (request.selectionRevision !== selection.selectionRevision)
      throw new Error("comparison_selection_cursor_stale");
    const members = new Set(selectedRunIds(selection));
    if (request.runIds.some((id) => !members.has(id)))
      throw new Error("comparison_run_not_selected");
    const ids = [
      ...new Set([...request.runIds, ...(selection.baselineRunId ? [selection.baselineRunId] : [])])
    ];
    const snapshots = new Map(
      ids.map((id) => {
        const run = deps.lookup(id);
        if (!run) throw new Error("comparison_run_not_found");
        return [id, { run, ...snapshot(deps.reader, run) }] as const;
      })
    );
    const selectedIdentity = selectionIdentity(request.metrics),
      sourceIdentity = hash([...snapshots].map(([id, s]) => [id, s.identity]));
    const binding = {
      comparisonId: selection.id,
      selectionRevision: selection.selectionRevision,
      selection: hash(selectedIdentity),
      runs: hash(request.runIds),
      sourceIdentity
    };
    let state = initial();
    let expectedNative: Record<string, string> = {};
    if (request.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(request.cursor, "base64url").toString());
        if (hash(parsed.binding) !== hash(binding)) throw new Error();
        const p = parsed.position;
        if (
          !p ||
          !["run", "metric", "row", "stat"].every((k) => Number.isSafeInteger(p[k]) && p[k] >= 0) ||
          typeof p.seen !== "boolean" ||
          (p.cursor !== undefined && typeof p.cursor !== "string") ||
          p.run >= request.runIds.length ||
          p.metric >= request.metrics.length
        )
          throw new Error();
        if (
          parsed.native &&
          (typeof parsed.native !== "object" ||
            Object.keys(parsed.native).length > 2 ||
            Object.entries(parsed.native).some(
              ([k, v]) => k.length !== 64 || typeof v !== "string" || v.length !== 64
            ))
        )
          throw new Error();
        expectedNative = parsed.native ?? {};
        state = p;
      } catch {
        throw new Error("comparison_metric_cursor_stale");
      }
    }
    const budget = new NativeQueryBudget();
    const abort = () => budget.fail("comparison_metric_projection_aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const deadline = Date.now() + 30000;
      let reads = 0;
      const check = () => {
        budget.check();
        if (options.signal?.aborted) throw new Error("comparison_metric_projection_aborted");
        if (Date.now() > deadline) throw new Error("comparison_metric_query_timeout");
      };
      const nativeIdentities = new Map<string, string>();
      const native = new Map<string, Awaited<ReturnType<NativeProjection>>>();
      let pageKey: string | undefined, cachedPage: ReturnType<SummaryReader["page"]> | undefined;
      const readPage = (runId: string, cursor?: string, tables = false) => {
        check();
        const key = JSON.stringify([runId, cursor, tables]);
        if (key === pageKey) return cachedPage!;
        if (++reads > 64) throw new Error("comparison_metric_request_budget_exceeded");
        const page = deps.reader.page(runId, {
          cursor,
          limit: 100,
          ...(tables ? { tablesOnly: true } : { nonTablesOnly: true })
        });
        if (Buffer.byteLength(JSON.stringify(page)) > 2 * 1024 * 1024)
          throw new Error("comparison_metric_page_budget_exceeded");
        pageKey = key;
        cachedPage = page;
        return page;
      };
      const response: MetricSelectionResponse = {
        contractVersion: COMPARISON_METRIC_SELECTION_VERSION,
        comparisonId: selection.id,
        selectionRevision: selection.selectionRevision,
        selectionIdentity: selectedIdentity,
        sourceIdentity,
        rows: [],
        hasMore: false,
        returnedRowCount: 0
      };
      const nextMetric = () => {
        state.metric++;
        state.cursor = undefined;
        state.row = 0;
        state.stat = 0;
        state.seen = false;
        if (state.metric >= request.metrics.length) state = { ...initial(), run: state.run + 1 };
      };
      const build = (
        runId: string,
        m: MetricSelection,
        d: ComparisonMetricDescriptor,
        dimensions: Record<string, string>,
        stat: MetricSelection["statistics"][number],
        a: any,
        b: any
      ): ProjectedMetricValue => {
        const owner = snapshots.get(runId)!,
          base = selection.baselineRunId ? snapshots.get(selection.baselineRunId) : undefined;
        const clean = (v: any) =>
          v?.availability !== "unavailable" &&
          typeof v?.value === "number" &&
          Number.isFinite(v.value) &&
          (v.unit === undefined || v.unit === d.units[stat])
            ? v.value
            : null;
        const value = clean(a),
          baselineValue = clean(b),
          isBaseline = runId === selection.baselineRunId;
        const difference = isBaseline
          ? { ...numericDifference(value, null), reason: "baseline_row" }
          : numericDifference(
              value,
              baselineValue,
              a?.unit === undefined ||
                b?.unit === undefined ||
                (a.unit === b.unit && a.unit === d.units[stat])
            );
        const rowId = hash([runId, m.metricId, dimensions, stat]);
        return {
          rowId,
          runId,
          runState: owner.run.state,
          measurementValidity: owner.run.measurementValidity,
          metricId: d.metricId,
          descriptorVersion: d.version,
          statistic: stat,
          unit: d.units[stat]!,
          dimensions,
          value,
          availability: value === null ? "unavailable" : a.availability,
          reasons:
            value === null
              ? a?.reasons?.length
                ? a.reasons
                : ["statistic_unavailable"]
              : (a.reasons ?? []),
          coverage: a?.coverage,
          sourceReferences: a?.sourceReferences ?? [],
          sourceIdentity: owner.identity,
          warnings: [
            ...warning(owner.run, owner.summary),
            ...(base && !isBaseline ? warning(base.run, base.summary, true) : [])
          ],
          ...(base && !isBaseline
            ? {
                baseline: {
                  runId: base.run.id,
                  value: baselineValue,
                  availability: baselineValue === null ? "unavailable" : b.availability,
                  sourceIdentity: base.identity
                }
              }
            : {}),
          difference
        };
      };
      const produce = async (): Promise<ProjectedMetricValue | undefined> => {
        while (state.run < request.runIds.length) {
          check();
          if (state.metric >= request.metrics.length) {
            state = { ...initial(), run: state.run + 1 };
            continue;
          }
          const runId = request.runIds[state.run],
            owner = snapshots.get(runId)!,
            m = request.metrics[state.metric],
            d = COMPARISON_METRIC_CATALOG.find((d) => d.metricId === m.metricId)!,
            base = selection.baselineRunId ? snapshots.get(selection.baselineRunId) : undefined;
          if (!stableSummary(owner.run, owner.summary)) {
            const stat = m.statistics[state.stat++];
            if (state.stat >= m.statistics.length) nextMetric();
            return build(
              runId,
              m,
              d,
              m.selectors,
              stat,
              unavailable(
                owner.summary.reason ??
                  (owner.summary.status !== "READY"
                    ? owner.summary.status.toLowerCase()
                    : "summary_source_identity_unavailable")
              ),
              unavailable("baseline_unavailable")
            );
          }
          if (d.domain === "workload") {
            const stat = m.statistics[state.stat++],
              a = workloadValue(owner.run, owner.summary, d),
              b =
                base && stableSummary(base.run, base.summary)
                  ? workloadValue(base.run, base.summary, d)
                  : unavailable("baseline_unavailable");
            if (state.stat >= m.statistics.length) nextMetric();
            return build(runId, m, d, {}, stat, a, b);
          }
          if (d.domain === "native_latch") {
            const get = async (s: typeof owner) => {
              const key = JSON.stringify([s.run.id, m.metricId, m.selectors]);
              if (!native.has(key))
                native.set(
                  key,
                  deps.nativeProjection
                    ? await deps.nativeProjection(s.run, s.summary, m, options.signal, budget)
                    : []
                );
              check();
              if (Buffer.byteLength(JSON.stringify([...native.values()])) > 32 * 1024 * 1024)
                throw new Error("comparison_metric_combined_budget_exceeded");
              const fingerprintKey = hash([s.run.id, m.metricId, m.selectors]),
                fingerprint = hash(native.get(key));
              if (expectedNative[fingerprintKey] && expectedNative[fingerprintKey] !== fingerprint)
                throw new Error("comparison_metric_cursor_stale");
              nativeIdentities.set(fingerprintKey, fingerprint);
              return native.get(key)!;
            };
            const a = await get(owner),
              b = base && stableSummary(base.run, base.summary) ? await get(base) : [];
            const rows = a.length
              ? a
              : [{ dimensions: m.selectors, ...unavailable("named_latch_evidence_unavailable") }];
            if (!rows[state.row]) throw new Error("comparison_metric_cursor_stale");
            const r = rows[state.row],
              stat = m.statistics[state.stat++],
              counterpart = b.find((x) => hash(x.dimensions) === hash(r.dimensions));
            if (state.stat >= m.statistics.length) {
              state.row++;
              state.stat = 0;
            }
            if (state.row >= rows.length) nextMetric();
            return build(
              runId,
              m,
              d,
              r.dimensions,
              stat,
              { ...r, availability: r.value === null ? "unavailable" : "available" },
              counterpart && {
                ...counterpart,
                availability: counterpart.value === null ? "unavailable" : "available"
              }
            );
          }
          if (owner.summary.status !== "READY") {
            const stat = m.statistics[state.stat++];
            if (state.stat >= m.statistics.length) nextMetric();
            return build(
              runId,
              m,
              d,
              m.selectors,
              stat,
              unavailable(owner.summary.reason ?? owner.summary.status.toLowerCase()),
              unavailable("baseline_unavailable")
            );
          }
          const page = readPage(
            runId,
            state.cursor,
            d.definitionId?.startsWith("db.table.") ?? false
          );
          while (state.row < page.rows.length) {
            check();
            const row = page.rows[state.row];
            const matches =
              row.group === d.group &&
              row.definitionId === d.definitionId &&
              row.coverageScope === d.scope &&
              Object.entries(m.selectors).every(([k, v]) => row.dimensions[k] === v);
            if (!matches) {
              state.row++;
              state.stat = 0;
              continue;
            }
            state.seen = true;
            const stat = m.statistics[state.stat++],
              a = row.statistics[stat as keyof typeof row.statistics],
              baselineRow =
                base && stableSummary(base.run, base.summary)
                  ? deps.reader.find(base.run.id, row.rowKey)
                  : undefined,
              b =
                baselineRow &&
                baselineRow.rowKey === row.rowKey &&
                baselineRow.group === row.group &&
                baselineRow.definitionId === row.definitionId &&
                baselineRow.coverageScope === row.coverageScope &&
                baselineRow.rateOrLevelUnit === row.rateOrLevelUnit &&
                baselineRow.totalUnit === row.totalUnit &&
                JSON.stringify(Object.entries(baselineRow.dimensions).sort()) ===
                  JSON.stringify(Object.entries(row.dimensions).sort())
                  ? baselineRow.statistics[stat as keyof typeof row.statistics]
                  : undefined;
            if (state.stat >= m.statistics.length) {
              state.row++;
              state.stat = 0;
            }
            return build(
              runId,
              m,
              d,
              row.dimensions,
              stat,
              a
                ? { ...a, availability: a.status, sourceReferences: row.sourceReferences }
                : unavailable("statistic_unavailable"),
              b ? { ...b, availability: b.status } : unavailable("baseline_statistic_unavailable")
            );
          }
          if (page.hasMore) {
            if (!page.nextCursor || page.nextCursor === state.cursor)
              throw new Error("comparison_metric_pagination_invalid");
            state.cursor = page.nextCursor;
            state.row = 0;
            continue;
          }
          if (!state.seen) {
            const stat = m.statistics[state.stat++];
            if (state.stat >= m.statistics.length) nextMetric();
            return build(
              runId,
              m,
              d,
              m.selectors,
              stat,
              unavailable("not_collected"),
              unavailable("baseline_statistic_unavailable")
            );
          }
          nextMetric();
        }
        return undefined;
      };
      while (response.rows.length < (request.limit ?? 100)) {
        const before = structuredClone(state),
          row = await produce();
        if (!row) break;
        response.rows.push(row);
        if (Buffer.byteLength(JSON.stringify(response)) > 2 * 1024 * 1024) {
          response.rows.pop();
          state = before;
          if (!response.rows.length) throw new Error("comparison_metric_response_budget_exceeded");
          break;
        }
      }
      const before = structuredClone(state);
      const more = await produce();
      state = before;
      response.hasMore = !!more;
      if (more) {
        const m = request.metrics[state.metric],
          runId = request.runIds[state.run];
        const nativeBinding = Object.fromEntries(
          [runId, selection.baselineRunId]
            .filter((id): id is string => !!id)
            .flatMap((id) => {
              const key = hash([id, m.metricId, m.selectors]),
                value = nativeIdentities.get(key);
              return value ? [[key, value]] : [];
            })
        );
        response.nextCursor = Buffer.from(
          JSON.stringify({ binding, position: state, native: nativeBinding })
        ).toString("base64url");
      }
      response.returnedRowCount = response.rows.length;
      check();
      for (const [id, s] of snapshots)
        if (snapshot(deps.reader, deps.lookup(id)!).identity !== s.identity)
          throw new Error("comparison_metric_source_changed");
      return response;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      budget.close();
    }
  };
}
