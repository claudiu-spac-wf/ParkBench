import { orderRankedSeries } from "./table-ranking";
import catalog from "../../../../packages/contracts/src/openedge-db-metric-catalog.json";
import type { RunTimeline } from "./run-timeline";
export type NativeMatrix = {
  metric: Record<string, string>;
  values: Array<[number, string | number | null]>;
};
export type CanonicalSeries = {
  metric: Record<string, string>;
  values: Array<[number, number | null]>;
};
export function phaseOwner(timeline: RunTimeline, timestamp: number): string | undefined {
  const t = timestamp * 1000;
  if (
    timeline.startedAt === undefined ||
    t < timeline.startedAt ||
    (timeline.endedAt !== undefined && t >= timeline.endedAt)
  )
    return undefined;
  const owners = timeline.phases.filter(
    (span) => t >= span.start && t < (span.end ?? timeline.endedAt ?? Infinity)
  );
  if (owners.length > 1) return undefined;
  return owners[0]?.phase ?? "idle";
}
export function nativePhaseWindows(
  timeline: RunTimeline,
  start: number,
  end: number,
  phase: string,
  now: number
): Array<{ start: number; end: number }> {
  const from = Math.max(start, timeline.startedAt ?? Infinity),
    to = Math.min(end, timeline.endedAt ?? now);
  if (to <= from) return [];
  if (phase === ".*") return [{ start: from / 1000, end: to / 1000 }];
  const selected = new Set(phase.split("|"));
  const spans = timeline.phases
    .map((s) => ({
      phase: s.phase,
      start: Math.max(from, s.start),
      end: Math.min(to, s.end ?? timeline.endedAt ?? now)
    }))
    .filter((s) => s.end > s.start);
  const windows = spans
    .filter((s) => selected.has(s.phase))
    .map((s) => ({ start: s.start, end: s.end }));
  if (selected.has("idle")) {
    let cursor = from;
    for (const s of spans.sort((a, b) => a.start - b.start)) {
      if (s.start > cursor) windows.push({ start: cursor, end: s.start });
      cursor = Math.max(cursor, s.end);
    }
    if (cursor < to) windows.push({ start: cursor, end: to });
  }
  return windows
    .sort((a, b) => a.start - b.start)
    .map((s) => ({ start: s.start / 1000, end: s.end / 1000 }));
}

/** Provisioning/cleanup outside reached workload phases have no promised native
 * observations. Count their observed portion only; never trim missing workload
 * coverage or explicit unavailable points inside the collection lifetime. */
function observedTotalWindows(
  windows: Array<{ start: number; end: number }>,
  points: CanonicalSeries["values"],
  timeline: RunTimeline
) {
  if (!points.length || !timeline.phases.length)
    return windows.map((window) => ({ ...window, includeStart: false }));
  const firstPhase = Math.min(...timeline.phases.map((p) => p.start)) / 1000;
  const lastPhase = timeline.phases.reduce((last, p) => (p.start > last.start ? p : last));
  const workloadEnd = lastPhase.end === undefined ? Infinity : lastPhase.end / 1000;
  return windows.map((window) => ({
    // The clipped start is an observed sample, not a requested range boundary.
    // Keep it so ordinary scrape jitter does not create an artificial edge gap.
    includeStart: window.start < points[0][0] && points[0][0] < firstPhase,
    start:
      window.start < firstPhase
        ? Math.max(window.start, Math.min(points[0][0], firstPhase))
        : window.start,
    end:
      window.end > workloadEnd
        ? Math.min(window.end, Math.max(points.at(-1)![0], workloadEnd))
        : window.end
  }));
}

function publisher(labels: Record<string, string>) {
  if (labels.job === "parkbench-control-plane") return "controller";
  if (["parkbench-runs", "parkbench-run-observers"].includes(labels.job)) return "endpoint";
  return labels.publisher;
}
/** Availability must belong to this exact owned tuple, epoch, publisher and acquisition. */
export function joinNamedLatchAvailability(
  input: NativeMatrix[],
  timelines: RunTimeline[]
): NativeMatrix[] {
  const named = input.filter((s) =>
    s.metric.__name__?.startsWith("parkbench_openedge_db_latch_named_")
  );
  if (!named.length) return input;
  const owners = new Map(timelines.map((t) => [t.runId, t.nativePublisher]));
  const key = (labels: Record<string, string>, measurement: string, time: number) =>
    JSON.stringify([
      labels.run_id,
      labels.database,
      labels.database_epoch,
      labels.latch_name,
      labels.latch_type,
      labels.latch_id,
      publisher(labels),
      measurement,
      time
    ]);
  const available = new Set<string>();
  for (const series of input.filter(
    (s) => s.metric.__name__ === "parkbench_openedge_db_metric_available"
  )) {
    if (
      owners.get(series.metric.run_id) &&
      publisher(series.metric) !== owners.get(series.metric.run_id)
    )
      continue;
    if (series.metric.reason !== "available") continue;
    for (const [time, value] of series.values)
      if (Number(value) === 1) available.add(key(series.metric, series.metric.measurement, time));
  }
  return input
    .filter((s) => s.metric.__name__ !== "parkbench_openedge_db_metric_available")
    .map((series) =>
      series.metric.__name__?.startsWith("parkbench_openedge_db_latch_named_")
        ? {
            ...series,
            values: series.values.map(([time, value]) => [
              time,
              available.has(
                key(
                  series.metric,
                  series.metric.__name__.replace("parkbench_openedge_db_", ""),
                  time
                )
              )
                ? value
                : null
            ])
          }
        : series
    );
}
export function canonicalNativeSeries(
  input: NativeMatrix[],
  timelines: RunTimeline[],
  check: () => void = () => {}
): CanonicalSeries[] {
  const byRun = new Map(timelines.map((t) => [t.runId, t]));
  const groups = new Map<
    string,
    { metric: Record<string, string>; points: Map<number, number | null>; publishers: Set<string> }
  >();
  for (const series of input) {
    check();
    const timeline = byRun.get(series.metric.run_id);
    if (!timeline) continue;
    const definition = catalog.entries.find(
      (e) => "parkbench_openedge_db_" + e.name === series.metric.__name__
    );
    if (!definition) throw new Error("native_diagnostic_metric_invalid");
    const recorded = timeline.nativePublisher;
    const origin = publisher(series.metric);
    if (recorded && origin !== recorded) continue;
    const metric = Object.fromEntries(
      [
        "__name__",
        "run_id",
        "database",
        "service",
        "database_epoch",
        ...definition.dimensions
      ].flatMap((k) => (series.metric[k] === undefined ? [] : [[k, series.metric[k]]]))
    );
    const key = JSON.stringify(Object.entries(metric).sort(([a], [b]) => a.localeCompare(b)));
    for (const [t, raw] of series.values) {
      check();
      if (!Number.isFinite(t)) continue;
      const owner = phaseOwner(timeline, t);
      if (!owner) continue;
      if (series.metric.phase && series.metric.phase !== owner) continue;
      if (!series.metric.phase && !timeline.continuousMetrics) continue;
      let group = groups.get(key);
      if (!group) {
        group = { metric, points: new Map(), publishers: new Set() };
        groups.set(key, group);
      }
      group.publishers.add(origin ?? "unverified");
      const value = raw === null ? null : Number(raw);
      const finite = value !== null && Number.isFinite(value) ? value : null;
      if (group.points.has(t) && group.points.get(t) !== finite) group.points.set(t, null);
      else if (!group.points.has(t)) group.points.set(t, finite);
    }
  }
  return [...groups.values()].map((group) => ({
    metric: group.metric,
    values: [...group.points]
      .sort(([a], [b]) => a - b)
      .map(([t, value]) => [
        t,
        group.publishers.size > 1 || group.publishers.has("unverified") ? null : value
      ])
  }));
}
/** Sum already reduced instance/epoch totals by semantic name/type, never raw counters. */
export function aggregateNamedLatchTotals<
  T extends {
    metric: Record<string, string>;
    value?: (number | string)[];
    values?: (number | string)[][];
  }
>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const labels = Object.fromEntries(
      Object.entries(row.metric).filter(
        ([k]) => !["latch_id", "database_epoch", "availability"].includes(k)
      )
    );
    const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0],
      metric = { ...first.metric };
    for (const key of ["latch_id", "database_epoch"]) {
      const identities = [...new Set(group.map((r) => r.metric[key]))];
      if (identities.length > 1) {
        delete metric[key];
        metric[key === "latch_id" ? "latch_instances" : "database_epochs"] = JSON.stringify(
          identities.sort()
        );
      }
    }
    const vectors = group.map((row) => (row.value ? [row.value] : row.values!));
    const values = vectors[0].map(([time], index) => {
      const parts = vectors.map((v) => v[index]);
      const valid = parts.every((p) => p && p[0] === time && Number.isFinite(Number(p[1])));
      const total = valid ? parts.reduce((sum, p) => sum + Number(p[1]), 0) : NaN;
      return [time, Number.isFinite(total) ? String(total) : "NaN"];
    });
    metric.availability = values.some((v) => v[1] !== "NaN") ? "available" : "unavailable";
    return { ...first, metric, ...(first.value ? { value: values[0] } : { values }) } as T;
  });
}
export function freeCapacity(capacity?: number, active?: number): number | null {
  return capacity !== undefined &&
    active !== undefined &&
    Number.isFinite(capacity) &&
    Number.isFinite(active) &&
    capacity > 0 &&
    active >= 0 &&
    active <= capacity
    ? capacity - active
    : null;
}
export function cumulativeHitRatio(logical?: number, os?: number): number | null {
  return logical !== undefined &&
    os !== undefined &&
    Number.isFinite(logical) &&
    Number.isFinite(os) &&
    logical > 0 &&
    os >= 0 &&
    os <= logical
    ? (logical - os) / logical
    : null;
}

import {
  NativeMatrixCache,
  NativeQueryBudget,
  nativeLimits,
  type NativeLimits,
  NativeBudgetError
} from "./native-query-budget";
import { counterWindow } from "./native-counter-window";
import type { LabelMatcher } from "./promql-selectors";
export function nativeDescriptor(matchers: LabelMatcher[], limits = nativeLimits()) {
  const labels = new Map<string, string>();
  for (const m of matchers) {
    if (labels.has(m.name)) throw new Error("native_descriptor_duplicate");
    labels.set(m.name, m.value);
  }
  const metric = labels.get("metric") ?? "",
    view = labels.get("view") ?? "";
  const derived = metric === "free_capacity" || metric === "cumulative_hit_ratio";
  const definition = catalog.entries.find((e) => e.name === metric);
  if (!derived && !definition) throw new Error("native_descriptor_metric_invalid");
  if (
    derived
      ? view !== (metric === "free_capacity" ? "gauge" : "cumulative")
      : definition!.type === "counter"
        ? !["rate", "total"].includes(view)
        : view !== "gauge"
  )
    throw new Error("native_descriptor_view_invalid");
  const group = labels.get("group");
  if (
    group !== undefined &&
    (group !== "name_type" ||
      !metric.startsWith("latch_named_") ||
      view !== "total" ||
      matchers.find((m) => m.name === "group")?.op !== "=")
  )
    throw new Error("native_descriptor_group_invalid");
  const start = Number(labels.get("window_start")),
    end = Number(labels.get("window_end"));
  if (
    !labels.get("window_start")?.trim() ||
    !labels.get("window_end")?.trim() ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > limits.windowMs
  )
    throw new Error("native_descriptor_window_invalid");
  const phase = labels.get("phase") ?? ".*";
  if (
    phase !== ".*" &&
    !phase.split("|").every((p) => ["idle", "warmup", "measurement", "cooldown"].includes(p))
  )
    throw new Error("native_descriptor_phase_invalid");
  const rateWindow = Number(labels.get("rate_window_ms") ?? 15000);
  if (!Number.isFinite(rateWindow) || rateWindow <= 0 || rateWindow > limits.windowMs)
    throw new Error("native_descriptor_rate_window_invalid");
  const allowed = new Set([
    "run_id",
    "metric",
    "view",
    "phase",
    "window_start",
    "window_end",
    "rate_window_ms",
    "group",
    ...(definition?.dimensions ?? ["pool", "database_epoch"])
  ]);
  for (const m of matchers)
    if (!allowed.has(m.name) || !["=", "=~"].includes(m.op) || m.value.length > 4096)
      throw new Error("native_descriptor_filter_invalid");
  const filters = matchers.filter(
    (m) =>
      ![
        "run_id",
        "metric",
        "view",
        "phase",
        "window_start",
        "window_end",
        "rate_window_ms",
        "group"
      ].includes(m.name)
  );
  const metrics =
    metric === "free_capacity"
      ? ["buffer_pool_configured_buffers", "buffer_pool_active_buffers"]
      : metric === "cumulative_hit_ratio"
        ? ["buffer_pool_logical_reads_total", "buffer_pool_os_reads_total"]
        : [metric];
  return { metric, view, start, end, phase, rateWindow, filters, metrics, group };
}
export function validateNativeOutputWindow(
  descriptor: { start: number; end: number },
  input: { start: number; end: number; step: number; instant: boolean },
  limits = nativeLimits()
) {
  // Grafana aligns the range grid down to an exact step boundary. Permit that
  // single leading grid point without expanding the source/selected window.
  const alignedLeadingPoint =
    !input.instant &&
    input.step > 0 &&
    input.start === Math.floor(descriptor.start / input.step) * input.step;
  if (
    !Number.isFinite(input.start) ||
    !Number.isFinite(input.end) ||
    input.end < input.start ||
    (!input.instant &&
      (!Number.isFinite(input.step) || input.step <= 0 || input.step > limits.windowMs)) ||
    input.end < descriptor.start ||
    (input.start < descriptor.start && !alignedLeadingPoint) ||
    input.end > descriptor.end
  )
    throw new Error("native_query_output_window_invalid");
}
function deriveSeries(series: CanonicalSeries[], metric: string): CanonicalSeries[] {
  if (!["free_capacity", "cumulative_hit_ratio"].includes(metric)) return series;
  const [left, right] =
    metric === "free_capacity"
      ? ["buffer_pool_configured_buffers", "buffer_pool_active_buffers"]
      : ["buffer_pool_logical_reads_total", "buffer_pool_os_reads_total"];
  const identity = (labels: Record<string, string>) =>
    JSON.stringify(
      Object.entries(labels)
        .filter(([k]) => k !== "__name__")
        .sort(([a], [b]) => a.localeCompare(b))
    );
  const second = new Map(
    series
      .filter((s) => s.metric.__name__ === "parkbench_openedge_db_" + right)
      .map((s) => [identity(s.metric), s])
  );
  return series
    .filter((s) => s.metric.__name__ === "parkbench_openedge_db_" + left)
    .map((s) => {
      const other = second.get(identity(s.metric)),
        values = new Map(other?.values ?? []);
      return {
        metric: { ...s.metric, __name__: "parkbench_db_diagnostic", diagnostic: metric },
        values: s.values.map(([t, v]) => [
          t,
          v === null || values.get(t) == null
            ? null
            : metric === "free_capacity"
              ? freeCapacity(v, values.get(t)!)
              : cumulativeHitRatio(v, values.get(t)!)
        ])
      };
    });
}
export function createNativeDiagnostics(options: {
  prometheusUrl: string;
  fetch?: typeof fetch;
  limits?: Partial<NativeLimits>;
  now?: () => number;
}) {
  const limits = nativeLimits(options.limits),
    cache = new NativeMatrixCache(limits),
    now = options.now ?? (() => Date.now());
  return async function query(input: {
    matchers: LabelMatcher[];
    timelines: RunTimeline[];
    start: number;
    end: number;
    step: number;
    instant: boolean;
    shift: (timeline: RunTimeline) => number;
    budget?: NativeQueryBudget;
  }) {
    const budget = input.budget ?? new NativeQueryBudget(limits);
    try {
      if (
        !input.instant &&
        (!Number.isFinite(input.step) ||
          input.step <= 0 ||
          !Number.isFinite(input.start) ||
          !Number.isFinite(input.end) ||
          input.end < input.start)
      )
        throw new Error("native_query_output_window_invalid");
      budget.check();
      const descriptor = nativeDescriptor(input.matchers, limits);
      validateNativeOutputWindow(descriptor, input, limits);
      const data = await Promise.all(
        input.timelines.map(async (timeline) => {
          budget.check();
          const shift = input.shift(timeline),
            cadence = timeline.nativeRefreshSeconds ?? 5,
            // Grafana's output grid can be finer than native collection. Four samples
            // keep left-open counter ranges usable despite normal acquisition jitter.
            rateWindow = Math.min(limits.windowMs, Math.max(descriptor.rateWindow, cadence * 4000));
          if (!Number.isFinite(cadence) || cadence <= 0 || !Number.isFinite(shift))
            throw new Error("native_query_cadence_or_shift_invalid");
          const start = (descriptor.start - rateWindow + shift) / 1000,
            end = (descriptor.end + shift) / 1000;
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
            throw new Error("native_query_fetch_window_invalid");
          const filter = descriptor.filters
            .map((m) => `,${m.name}${m.op}${JSON.stringify(m.value)}`)
            .join("");
          const selector = `{__name__=~${JSON.stringify([...descriptor.metrics.map((n) => "parkbench_openedge_db_" + n), ...(descriptor.metric.startsWith("latch_named_") ? ["parkbench_openedge_db_metric_available"] : [])].join("|"))},run_id=${JSON.stringify(timeline.runId)}${filter}}`;
          const key = JSON.stringify([
            timeline.runId,
            descriptor,
            timeline.nativePublisher,
            timeline.continuousMetrics,
            timeline.phases,
            start,
            end,
            timeline.endedAt === undefined
              ? Math.floor(now() / (cadence * 1000))
              : [timeline.endedAt, Math.floor(now() / 300000)]
          ]);
          budget.check();
          let raw = cache.getMatchingPrefix(key + "\0epochs:");
          budget.check();
          if (!raw) {
            const body = await budget.fetch(
              options.prometheusUrl.replace(/\/$/, "") + "/api/v1/query",
              new URLSearchParams({
                query: `${selector}[${Math.ceil((end - start + Math.min(cadence, limits.windowMs / 1000)) * 1000)}ms]`,
                time: String(end)
              }),
              options.fetch
            );
            if (body.data?.resultType !== "matrix" || !Array.isArray(body.data.result))
              throw new NativeBudgetError("native_query_matrix_invalid");
            raw = body.data.result;
          }
          const canonical = canonicalNativeSeries(
            joinNamedLatchAvailability(raw, [timeline]),
            [timeline],
            () => budget.check()
          );
          const selected = deriveSeries(canonical, descriptor.metric);
          const matches = (phase: string) =>
            descriptor.phase === ".*" || descriptor.phase.split("|").includes(phase);
          const windows = nativePhaseWindows(
            timeline,
            descriptor.start + shift - (descriptor.view === "rate" ? rateWindow : 0),
            descriptor.end + shift,
            descriptor.phase,
            now()
          );
          const rows = selected.map((series) => {
            budget.check();
            const points = series.values;
            const at = (time: number): number | null => {
              if (
                time < (descriptor.start + shift) / 1000 ||
                time > (descriptor.end + shift) / 1000
              )
                return null;
              if (!matches(phaseOwner(timeline, time) ?? "")) return null;
              if (descriptor.view === "rate") {
                const span = windows.find((w) => time >= w.start && time <= w.end);
                if (!span) return null;
                return (
                  counterWindow(
                    points,
                    Math.max(span.start, time - rateWindow / 1000),
                    time,
                    cadence
                  )?.rate ?? null
                );
              }
              let point: [number, number | null] | undefined;
              for (const p of points) {
                budget.check();
                if (p[0] > time) break;
                point = p;
              }
              return point && time - point[0] <= cadence * 1.5 ? point[1] : null;
            };
            let total: number | null = null;
            if (descriptor.view === "total")
              for (const window of observedTotalWindows(windows, points, timeline)) {
                budget.check();
                if (window.end <= window.start) continue;
                const value = counterWindow(
                  points,
                  window.start,
                  window.end,
                  cadence,
                  window.includeStart || descriptor.metric.startsWith("latch_named_")
                );
                if (!value) {
                  total = null;
                  break;
                }
                total = (total ?? 0) + value.increase;
              }
            const count = input.instant
              ? 1
              : Math.floor((input.end - input.start) / input.step) + 1;
            if (count > 200000) throw new NativeBudgetError("native_query_output_budget_exceeded");
            const times = input.instant
              ? [input.end]
              : Array.from({ length: count }, (_, i) => input.start + i * input.step);
            const values = times.map((t) => {
              budget.check();
              const value = descriptor.view === "total" ? total : at((t + shift) / 1000);
              return [t / 1000, value === null ? "NaN" : String(value)];
            });
            return {
              metric: {
                ...series.metric,
                diagnostic: descriptor.metric,
                availability: values.some(([, v]) => v !== "NaN") ? "available" : "unavailable"
              },
              ...(input.instant ? { value: values[0] } : { values })
            };
          });
          budget.check();
          return {
            rows: descriptor.group === "name_type" ? aggregateNamedLatchTotals(rows) : rows,
            key:
              key +
              "\0epochs:" +
              JSON.stringify(
                [
                  ...new Set<string>(
                    raw.map((s: NativeMatrix) => s.metric.database_epoch ?? "none")
                  )
                ].sort()
              ),
            raw
          };
        })
      );
      const rows = data.flatMap((item) => item.rows);
      const ordered = orderRankedSeries(rows, descriptor.view === "total" ? "total" : "rate");
      // No failed/partial query enters the adapter-wide cache.
      budget.check();
      cache.setBatch(
        data.map((item) => [item.key, item.raw]),
        () => budget.check()
      );
      return ordered;
    } catch (error) {
      budget.fail(
        error instanceof NativeBudgetError ? error.code : "native_diagnostic_query_failed"
      );
      throw error;
    } finally {
      if (!input.budget) budget.close();
    }
  };
}
