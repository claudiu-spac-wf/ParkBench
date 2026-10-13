import { sumRunTotals } from "./run-totals";
import type { ParameterSnapshotQueries } from "./parameter-snapshots";
import type { SavedSummaryQueries } from "./summary-results";
import { requestId, structuredLog } from "../../../../packages/contracts/src/logging";
import { ALIGNED_ANCHOR_MS, Mode, modeFor, modeMismatch, isAlignedRange } from "./alignment";
import { analyzeRunScope, narrowToRun, RUN_LABEL, SYNTHETIC_METRICS } from "./run-scope";
import { RunTimeline, RunTimelineSource } from "./run-timeline";
import { SeriesPoint, syntheticSeries } from "./synthetic-series";
import { rankCanonicalTables, orderRankedSeries } from "./table-ranking";
import { scanSelectors } from "./promql-selectors";
import {
  createNativeDiagnostics,
  nativeDescriptor,
  validateNativeOutputWindow
} from "./native-diagnostics";
import { NativeBudgetError, nativeLimits, type NativeLimits } from "./native-query-budget";
import { continuousPhaseQuery } from "./continuous-phases";

export const PROM_PREFIX = "/api/v1/grafana/prom";

export interface GrafanaDatasourceDeps {
  metricsAvailability?: (
    ids: string[]
  ) => Promise<Record<string, import("../runs/metrics-availability").MetricsAvailability>>;
  parameterSnapshots?: ParameterSnapshotQueries;
  savedSummaries?: SavedSummaryQueries;
  nativeDiagnosticsLimits?: Partial<NativeLimits>;
  prometheusUrl: string;
  timelines: RunTimelineSource;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
}

type ErrorClass =
  | "run_matcher_required"
  | "run_matcher_mismatch"
  | "bad_query"
  | "upstream_error"
  | "upstream_timeout"
  | "run_store_unavailable"
  | "mode_mismatch"
  | "native_diagnostic_error";

interface Outcome {
  status: number;
  body: unknown;
  mode?: Mode;
  runs?: string[];
  errorClass?: ErrorClass;
}

class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly errorClass: ErrorClass
  ) {
    super(errorClass);
  }
}

function badData(errorClass: ErrorClass, status = 400): Outcome {
  return {
    status,
    body: { status: "error", errorType: "bad_data", error: errorClass },
    errorClass
  };
}

/** Prometheus accepts unix seconds (possibly fractional) or RFC 3339. */
function toMs(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stepMs(value: string | null): number {
  if (!value) return 15000;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric * 1000;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (!match) return 15000;
  const factor = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2] as "s"];
  return Number(match[1]) * factor;
}

function secondsString(ms: number): string {
  return String(ms / 1000);
}

function formatSeries(points: SeriesPoint[], instant: boolean) {
  return instant
    ? {
        status: "success",
        data: {
          resultType: "vector",
          result: points.map((p) => ({
            metric: p.metric,
            value: [p.points[0][0] / 1000, String(p.points[0][1])]
          }))
        }
      }
    : {
        status: "success",
        data: {
          resultType: "matrix",
          result: points.map((p) => ({
            metric: p.metric,
            values: p.points.map(([t, v]) => [t / 1000, String(v)])
          }))
        }
      };
}

function emptyResult(instant: boolean) {
  return { status: "success", data: { resultType: instant ? "vector" : "matrix", result: [] } };
}

/** Reads query-string and form-body parameters into one URLSearchParams. */
function requestParams(request: any): URLSearchParams {
  const url = String(request.raw?.url ?? request.url ?? "");
  const params = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
  if (typeof request.body === "string" && request.body) {
    for (const [key, value] of new URLSearchParams(request.body)) params.append(key, value);
  }
  return params;
}

export function createGrafanaDatasource(deps: GrafanaDatasourceDeps) {
  const nativeDiagnostic = createNativeDiagnostics({
    prometheusUrl: deps.prometheusUrl,
    fetch: deps.fetch,
    limits: deps.nativeDiagnosticsLimits,
    now: deps.now
  });
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));

  async function upstream(path: string, params: URLSearchParams, method: "GET" | "POST" = "POST") {
    const url = `${deps.prometheusUrl.replace(/\/$/, "")}/api/v1/${path}`;
    let response: Response;
    try {
      response =
        method === "GET"
          ? await fetchImpl(`${url}${params.size ? `?${params}` : ""}`, {
              signal: AbortSignal.timeout(30000)
            })
          : await fetchImpl(url, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: params.toString(),
              signal: AbortSignal.timeout(30000)
            });
    } catch (error) {
      const timeout = String((error as any)?.name ?? "").includes("Timeout");
      throw new UpstreamError(
        503,
        { status: "error", errorType: timeout ? "timeout" : "unavailable", error: String(error) },
        timeout ? "upstream_timeout" : "upstream_error"
      );
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body)
      for await (const chunk of response.body as any) {
        bytes += chunk.byteLength;
        if (bytes > 8 * 1024 * 1024)
          throw new UpstreamError(
            503,
            { status: "error", error: "upstream_response_too_large" },
            "upstream_error"
          );
        chunks.push(chunk);
      }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { status: "error", errorType: "internal", error: text.slice(0, 500) };
    }
    if (!response.ok) throw new UpstreamError(response.status, body, "upstream_error");
    return body as any;
  }

  function timelinesFor(runIds: string[]): RunTimeline[] {
    try {
      return runIds.map((id) => deps.timelines.get(id)).filter((t): t is RunTimeline => Boolean(t));
    } catch {
      throw new UpstreamError(
        503,
        { status: "error", errorType: "unavailable", error: "run_store_unavailable" },
        "run_store_unavailable"
      );
    }
  }

  async function dataQuery(params: URLSearchParams, instant: boolean): Promise<Outcome> {
    const expr = params.get("query") ?? "";
    const current = now();
    const start = instant
      ? toMs(params.get("time"), current)
      : toMs(params.get("start"), current - 3600000);
    const end = instant ? start : toMs(params.get("end"), current);
    const step = instant ? 0 : stepMs(params.get("step"));
    const scope = analyzeRunScope(expr);
    const path = instant ? "query" : "query_range";
    if (scope.kind === "error") return badData(scope.errorClass);
    if (scope.kind === "constant") return { status: 200, body: await upstream(path, params) };
    if (scope.kind === "synthetic") {
      const aggregate = scope.matchers.filter((m) => m.name === "aggregate");
      const aggregateRun = aggregate.length > 0;
      if (aggregateRun) {
        const labels = new Map(scope.matchers.map((m) => [m.name, m.value]));
        const supported =
          scope.metric === "parkbench_table_rank"
            ? ["read", "write"].includes(labels.get("operation") ?? "")
            : scope.metric === "parkbench_db_diagnostic" &&
              ["index_blocks_read_total", "index_blocks_written_total"].includes(
                labels.get("metric") ?? ""
              );
        if (
          !instant ||
          aggregate.length !== 1 ||
          aggregate[0].op !== "=" ||
          aggregate[0].value !== "run" ||
          labels.get("view") !== "total" ||
          !supported
        )
          return badData("bad_query");
        // Presentation aggregation is not an upstream native metric filter.
        scope.matchers = scope.matchers.filter((m) => m.name !== "aggregate");
      }
      const totalDeadline = Date.now() + (deps.nativeDiagnosticsLimits?.deadlineMs ?? 30000);
      const checkTotal = () => {
        if (Date.now() >= totalDeadline) throw new NativeBudgetError("native_query_deadline_exceeded");
      };
      const runIds = scope.runIds;
      const timelines = runIds === undefined ? deps.timelines.list() : timelinesFor(runIds);
      const windowLabels = new Map(scope.matchers.map((m) => [m.name, m.value]));
      const explicitWindow = windowLabels.has("window_start") || windowLabels.has("window_end");
      let windowStart = start,
        windowEnd = end;
      if (explicitWindow) {
        windowStart = Number(windowLabels.get("window_start"));
        windowEnd = Number(windowLabels.get("window_end"));
        if (
          !windowLabels.get("window_start")?.trim() ||
          !windowLabels.get("window_end")?.trim() ||
          !Number.isFinite(windowStart) ||
          !Number.isFinite(windowEnd) ||
          windowEnd < windowStart ||
          windowEnd - windowStart > 31 * 86400_000
        )
          return badData("bad_query");
      }
      const notice = scope.metric === "parkbench_run_notice_text";
      if (
        notice &&
        (!explicitWindow ||
          !["time_range", "excluded_runs"].includes(windowLabels.get("kind") ?? "") ||
          timelines.length !== runIds?.length ||
          scope.matchers.some(
            (m) => !["run_id", "kind", "window_start", "window_end"].includes(m.name)
          ))
      )
        return badData("bad_query");
      const mode =
        scope.metric === "parkbench_run_window" &&
        runIds === undefined &&
        isAlignedRange(windowStart, windowEnd)
          ? "aligned"
          : modeFor(runIds?.length ?? 1);
      const mismatch = runIds?.length ? modeMismatch(mode, windowStart, windowEnd) : undefined;
      if (
        mismatch &&
        ![
          "parkbench_run_mode_mismatch",
          "parkbench_run_notice_text",
          "parkbench_run_window"
        ].includes(scope.metric)
      )
        return {
          status: 200,
          body: emptyResult(instant),
          mode,
          runs: runIds,
          errorClass: "mode_mismatch"
        };
      if (scope.metric === "parkbench_db_diagnostic") {
        if (!runIds?.length || timelines.length !== runIds.length) return badData("bad_query");
        try {
          const descriptor = nativeDescriptor(
            scope.matchers,
            nativeLimits(deps.nativeDiagnosticsLimits)
          );
          validateNativeOutputWindow(
            descriptor,
            { start, end, step, instant },
            nativeLimits(deps.nativeDiagnosticsLimits)
          );
        } catch (error) {
          return {
            status: 400,
            body: { status: "error", errorType: "bad_data", error: (error as Error).message },
            errorClass: "bad_query"
          };
        }
        try {
          const result = await nativeDiagnostic({
            matchers: scope.matchers,
            timelines: timelines.filter(
              (t) => mode !== "aligned" || t.measurementStart !== undefined
            ),
            start,
            end,
            step,
            instant,
            shift: (t) => (mode === "aligned" ? t.measurementStart! - ALIGNED_ANCHOR_MS : 0)
          });
          return {
            status: 200,
            body: {
              status: "success",
              data: {
                resultType: instant ? "vector" : "matrix",
                result: aggregateRun ? sumRunTotals(result, checkTotal) : result
              }
            },
            mode,
            runs: runIds
          };
        } catch (error) {
          return {
            status: 503,
            body: {
              status: "error",
              errorType: "unavailable",
              error: error instanceof NativeBudgetError ? error.code : (error as Error).message
            },
            errorClass: "native_diagnostic_error",
            mode,
            runs: runIds
          };
        }
      }
      if (scope.metric === "parkbench_table_rank") {
        const labels = new Map(scope.matchers.map((m) => [m.name, m.value]));
        if (!runIds?.length || (labels.get("view") !== "rate" && labels.get("view") !== "total"))
          return badData("bad_query");
        const operation = labels.get("operation") ?? "read";
        if (
          timelines.length !== runIds.length ||
          !["read", "create", "update", "delete", "write", "os_read"].includes(operation) ||
          scope.matchers.some(
            (m) =>
              !["run_id", "operation", "phase", "view", "window_start", "window_end"].includes(
                m.name
              )
          )
        )
          return badData("bad_query");
        const view = labels.get("view") as "rate" | "total";
        const matchers = scope.matchers.filter((m) => m.name !== "operation");
        matchers.push({
          name: "rate_window_ms",
          op: "=",
          value: String(Math.max(1000, step) * 2),
          start: 0,
          end: 0
        });
        matchers.push(
          { name: "metric", op: "=", value: "table_operations_total", start: 0, end: 0 },
          {
            name: "operation",
            op: operation === "write" ? "=~" : "=",
            value: operation === "write" ? "create|update|delete" : operation,
            start: 0,
            end: 0
          }
        );
        try {
          nativeDescriptor(matchers);
        } catch (error) {
          return badData("bad_query");
        }
        const fullStart = Number(labels.get("window_start")),
          fullEnd = Number(labels.get("window_end"));
        const deadline = Date.now() + (deps.nativeDiagnosticsLimits?.deadlineMs ?? 30000);
        try {
          const raw = await nativeDiagnostic({
            matchers,
            timelines: timelines.filter(
              (t) => mode !== "aligned" || t.measurementStart !== undefined
            ),
            start: fullStart,
            end: fullEnd,
            step: Math.max(1000, step),
            instant: view === "total",
            shift: (t) => (mode === "aligned" ? t.measurementStart! - ALIGNED_ANCHOR_MS : 0)
          });
          const result = rankCanonicalTables(raw, view, operation, instant, start, end, () => {
            if (Date.now() >= deadline)
              throw new NativeBudgetError("native_query_deadline_exceeded");
          });
          const body = {
            status: "success",
            data: {
              resultType: instant ? "vector" : "matrix",
              result: aggregateRun ? sumRunTotals(result, checkTotal) : result
            }
          };
          if (Date.now() >= deadline) throw new NativeBudgetError("native_query_deadline_exceeded");
          if (Buffer.byteLength(JSON.stringify(body)) > 8 * 1024 * 1024)
            throw new NativeBudgetError("native_query_response_budget_exceeded");
          return { status: 200, body, mode, runs: runIds };
        } catch (error) {
          return {
            status: 503,
            body: {
              status: "error",
              errorType: "unavailable",
              error: error instanceof NativeBudgetError ? error.code : (error as Error).message
            },
            errorClass: "native_diagnostic_error",
            mode,
            runs: runIds
          };
        }
      }

      if (
        scope.metric === "parkbench_saved_summary" ||
        scope.metric.startsWith("parkbench_parameter_snapshot_")
      ) {
        if (!runIds?.length) return badData("run_matcher_required");
        const result: any[] = [];
        const labels = new Map(scope.matchers.map((m) => [m.name, m.value]));
        for (const timeline of timelines) {
          if (scope.metric === "parkbench_saved_summary")
            result.push(...((await deps.savedSummaries?.query(timeline.runId, labels, end)) ?? []));
          else
            result.push(
              ...((await deps.parameterSnapshots?.query(
                timeline.runId,
                scope.metric.slice("parkbench_parameter_snapshot_".length) as
                  "info" | "numeric" | "status",
                end,
                upstream
              )) ?? [])
            );
        }
        if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
          return badData("bad_query");
        // Numeric capture timestamps are field values; they never move with an aligned axis.
        return {
          status: 200,
          body: {
            status: "success",
            data: {
              resultType: instant ? "vector" : "matrix",
              result: instant
                ? result
                : result.map((r) => ({ metric: r.metric, values: [r.value] }))
            }
          },
          mode,
          runs: runIds
        };
      }
      const excluded =
        mode === "aligned"
          ? timelines.filter((t) => t.measurementStart === undefined).map((t) => t.runId)
          : [];
      const series = syntheticSeries({
        metric: scope.metric,
        windowStart,
        windowEnd,
        noticeKind: windowLabels.get("kind") as "time_range" | "excluded_runs" | undefined,
        timelines,
        mode,
        start,
        end,
        step,
        excluded,
        mismatch,
        now: current
      });
      const body = formatSeries(series, instant);
      if (Buffer.byteLength(JSON.stringify(body)) > 8 * 1048576)
        return {
          status: 503,
          body: { status: "error", error: "run_store_response_budget_exceeded" },
          errorClass: "run_store_unavailable"
        };
      return {
        status: 200,
        body,
        mode,
        runs: runIds,
        errorClass: mismatch ? "mode_mismatch" : undefined
      };
    }
    const mode = modeFor(scope.runIds.length);
    if (modeMismatch(mode, start, end))
      return {
        status: 200,
        body: emptyResult(instant),
        mode,
        runs: scope.runIds,
        errorClass: "mode_mismatch"
      };
    if (mode === "clock") {
      const timeline = timelinesFor(scope.runIds)[0];
      const phaseQuery = timeline ? continuousPhaseQuery(expr, timeline) : undefined;
      const request = new URLSearchParams(params);
      if (phaseQuery) request.set("query", phaseQuery.expression);
      const body = await upstream(path, request);
      return chartOutcome(
        phaseQuery ? phaseQuery.filter(body) : body,
        scope.runIds,
        mode,
        start,
        end
      );
    }
    const result: unknown[] = [];
    for (const timeline of timelinesFor(scope.runIds)) {
      if (timeline.measurementStart === undefined) continue;
      const shift = timeline.measurementStart - ALIGNED_ANCHOR_MS;
      const narrowed = new URLSearchParams(params);
      const phaseQuery = continuousPhaseQuery(
        narrowToRun(expr, scope.runMatchers, timeline.runId),
        timeline
      );
      narrowed.set("query", phaseQuery.expression);
      if (instant) narrowed.set("time", secondsString(start + shift));
      else {
        narrowed.set("start", secondsString(start + shift));
        narrowed.set("end", secondsString(end + shift));
      }
      const body = phaseQuery.filter(await upstream(path, narrowed));
      for (const series of body?.data?.result ?? []) {
        if (Array.isArray(series.values))
          series.values = series.values.map(([t, v]: [number, string]) => [t - shift / 1000, v]);
        if (Array.isArray(series.value))
          series.value = [series.value[0] - shift / 1000, series.value[1]];
        result.push(series);
      }
    }
    return chartOutcome(
      { status: "success", data: { resultType: instant ? "vector" : "matrix", result } },
      scope.runIds,
      mode,
      start,
      end
    );
  }

  async function chartOutcome(
    body: any,
    ids: string[],
    mode: Mode,
    start: number,
    end: number
  ): Promise<Outcome> {
    if (Array.isArray(body?.data?.result)) {
      body = {
        ...body,
        data: { ...body.data, result: orderRankedSeries(body.data.result, "rate") }
      };
    }
    if (!deps.metricsAvailability) return { status: 200, body, mode, runs: ids };
    const inWindow = timelinesFor(ids)
      .filter((t) => {
        if (t.measurementStart === undefined) return false;
        const shift = mode === "aligned" ? t.measurementStart - ALIGNED_ANCHOR_MS : 0;
        return end + shift >= t.measurementStart && start + shift <= (t.endedAt ?? Infinity);
      })
      .map((t) => t.runId);
    if (!inWindow.length) return { status: 200, body, mode, runs: ids };
    const availability = await deps.metricsAvailability(inWindow);
    const absent = inWindow.filter((id) => ["expired", "unavailable"].includes(availability[id]));
    if (!absent.length) return { status: 200, body, mode, runs: ids };
    const expired = absent.some((id) => availability[id] === "expired");
    const reason = expired ? "metrics_expired" : "metrics_unavailable";
    const message = `Run metrics are no longer available in Prometheus for ${absent.join(", ")}. Saved summaries remain available.`;
    if (!body?.data?.result?.length)
      return {
        status: 410,
        body: {
          status: "error",
          errorType: reason,
          error: message,
          metricsAvailability: availability
        },
        mode,
        runs: ids
      };
    return {
      status: 200,
      body: { ...body, warnings: [...(body.warnings ?? []), reason + ": " + message] },
      mode,
      runs: ids
    };
  }

  /** series / labels / label values: synthetic-only matches are answered from the run store. */
  async function metadataQuery(
    kind: "series" | "labels" | "values",
    params: URLSearchParams,
    label?: string
  ): Promise<Outcome> {
    const matches = params.getAll("match[]");
    const syntheticOnly =
      matches.length > 0 &&
      matches.every((match) => {
        try {
          const selectors = scanSelectors(match);
          return selectors.length === 1 && SYNTHETIC_METRICS.has(selectors[0].metric ?? "");
        } catch {
          return false;
        }
      });
    if (!syntheticOnly) {
      const path =
        kind === "series"
          ? "series"
          : kind === "labels"
            ? "labels"
            : `label/${encodeURIComponent(label!)}/values`;
      const body = await upstream(path, params, "GET");
      if (kind === "values" && label === "__name__" && Array.isArray(body?.data))
        body.data = [...new Set([...body.data, ...SYNTHETIC_METRICS])].sort();
      return { status: 200, body };
    }
    const all = deps.timelines.list();
    const windows = syntheticSeries({
      metric: "parkbench_run_window",
      timelines: all,
      mode: "clock",
      start: Number.MIN_SAFE_INTEGER,
      end: Number.MAX_SAFE_INTEGER,
      step: 0,
      now: now()
    }).map((series) => series.metric);
    if (kind === "series") return { status: 200, body: { status: "success", data: windows } };
    if (kind === "labels")
      return {
        status: 200,
        body: {
          status: "success",
          data: [...new Set(windows.flatMap((m) => Object.keys(m)))].sort()
        }
      };
    const values =
      label === RUN_LABEL
        ? all.map((t) => t.runId)
        : [...new Set(windows.map((m) => m[label!]).filter(Boolean))];
    return { status: 200, body: { status: "success", data: values } };
  }

  async function handle(endpoint: string, run: () => Promise<Outcome>, reply: any) {
    const id = requestId("grafana");
    const started = Date.now();
    let outcome: Outcome;
    try {
      outcome = await run();
    } catch (error) {
      if (error instanceof UpstreamError)
        outcome = { status: error.status, body: error.body, errorClass: error.errorClass };
      else
        outcome = {
          ...badData("bad_query", 500),
          body: { status: "error", errorType: "internal", error: String(error) }
        };
    }
    log(
      structuredLog(
        outcome.errorClass && outcome.errorClass !== "mode_mismatch" ? "warn" : "info",
        "grafana_datasource_request",
        {
          requestId: id,
          endpoint,
          mode: outcome.mode,
          runs: outcome.runs ?? [],
          durationMs: Date.now() - started,
          outcome: outcome.status < 400 ? "success" : "error",
          errorClass: outcome.errorClass
        }
      )
    );
    reply.code(outcome.status);
    reply.header("content-type", "application/json");
    return outcome.body;
  }

  return { dataQuery, metadataQuery, handle, upstream };
}

/** Registers the Prometheus-compatible "ParkBench Runs" datasource routes. */
export function registerGrafanaDatasourceRoutes(app: any, deps: GrafanaDatasourceDeps): void {
  const datasource = createGrafanaDatasource(deps);
  void app.register(async (scope: any) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request: any, body: string, done: (error: Error | null, value?: string) => void) =>
        done(null, body)
    );
    const both = (path: string, handler: (request: any, reply: any) => Promise<unknown>) => {
      scope.get(`${PROM_PREFIX}/api/v1/${path}`, handler);
      scope.post(`${PROM_PREFIX}/api/v1/${path}`, handler);
    };
    both("query", (request, reply) =>
      datasource.handle("query", () => datasource.dataQuery(requestParams(request), true), reply)
    );
    both("query_range", (request, reply) =>
      datasource.handle(
        "query_range",
        () => datasource.dataQuery(requestParams(request), false),
        reply
      )
    );
    both("query_exemplars", (request, reply) =>
      datasource.handle(
        "query_exemplars",
        async () => {
          const params = requestParams(request);
          const scope = analyzeRunScope(params.get("query") ?? "");
          if (scope.kind === "error") return badData(scope.errorClass);
          return { status: 200, body: { status: "success", data: [] } };
        },
        reply
      )
    );
    both("series", (request, reply) =>
      datasource.handle(
        "series",
        () => datasource.metadataQuery("series", requestParams(request)),
        reply
      )
    );
    both("labels", (request, reply) =>
      datasource.handle(
        "labels",
        () => datasource.metadataQuery("labels", requestParams(request)),
        reply
      )
    );
    both("label/:name/values", (request, reply) =>
      datasource.handle(
        "label_values",
        () => datasource.metadataQuery("values", requestParams(request), request.params.name),
        reply
      )
    );
    for (const path of ["status/buildinfo", "metadata", "format_query"])
      both(path, (request, reply) =>
        datasource.handle(
          path,
          async () => ({
            status: 200,
            body: await datasource.upstream(path, requestParams(request), "GET")
          }),
          reply
        )
      );
    scope.all(`${PROM_PREFIX}/*`, async (_request: any, reply: any) => {
      reply.code(404);
      return { status: "error", errorType: "not_found", error: "endpoint_not_supported" };
    });
  });
}
