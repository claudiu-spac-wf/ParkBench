import { RunTimeline } from "./run-timeline";
import { continuousPhaseQuery } from "./continuous-phases";
/** Read-only Grafana display ranking. These identities and remainders are never persisted. */

export class TableRankSelector {
  private values: Array<{ name: string; score: number }> = [];
  constructor(private readonly limit = 10) {}
  add(name: string, score: number | null): void {
    if (
      !name ||
      name.toLowerCase() === "other" ||
      score === null ||
      !Number.isFinite(score) ||
      score < 0
    )
      return;
    const previous = this.values.find((v) => v.name === name);
    if (previous) {
      if (previous.score !== score) throw new Error("table_rank_duplicate_score");
      return;
    }
    this.values.push({ name, score });
    this.values.sort(
      (a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
    this.values.length = Math.min(this.values.length, this.limit);
  }
  names(): string[] {
    return this.values.map((v) => v.name);
  }
}
/** Sort displayed series without changing membership or mutating source responses. */
export function orderRankedSeries(rows: any[], view: "rate" | "total"): any[] {
  const scored = rows.map((row, ordinal) => {
    const points = row.values ?? (row.value ? [row.value] : []);
    const values = points.map((p: any[]) => Number(p[1])).filter(Number.isFinite);
    const score =
      view === "total"
        ? points.length && Number.isFinite(Number(points[points.length - 1][1]))
          ? Number(points[points.length - 1][1])
          : null
        : values.length
          ? values.reduce((a: number, b: number) => a + b, 0) / values.length
          : null;
    return {
      row,
      score,
      ordinal,
      name: row.metric?.table ?? row.metric?.run_id ?? "",
      identity: JSON.stringify(
        Object.entries(row.metric ?? {}).sort(([a], [b]) => a.localeCompare(b))
      )
    };
  });
  return scored
    .sort(
      (a, b) =>
        (a.score === null && b.score === null
          ? 0
          : a.score === null
            ? 1
            : b.score === null
              ? -1
              : b.score - a.score) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0) ||
        a.ordinal - b.ordinal
    )
    .map((item) => item.row);
}
/** Rank canonical table observations; operation sums never join independent epochs. */
export function rankCanonicalTables(
  rows: any[],
  view: "rate" | "total",
  operation: string,
  instant: boolean,
  start: number,
  end: number,
  check: () => void = () => {}
): any[] {
  const operations = operation === "write" ? ["create", "update", "delete"] : [operation];
  const grouped = new Map<string, { metric: Record<string, string>; contributors: any[] }>();
  for (const row of rows) {
    check();
    const metric = { ...row.metric };
    delete metric.operation;
    delete metric.availability;
    const key = JSON.stringify(Object.entries(metric).sort(([a], [b]) => a.localeCompare(b)));
    const entry = grouped.get(key) ?? { metric, contributors: [] };
    entry.contributors.push(row);
    grouped.set(key, entry);
  }
  const aggregated: any[] = [...grouped.values()].map((entry) => {
    const points = entry.contributors[0].values ?? [entry.contributors[0].value];
    const maps = entry.contributors.map(
      (row) => new Map<number, string>((row.values ?? [row.value]).map((p: any) => [p[0], p[1]]))
    );
    const complete = operations.every((op) =>
      entry.contributors.some((row) => row.metric.operation === op)
    );
    const values = points.map(([time]: [number, string]) => {
      check();
      const numbers = maps.map((map) => Number(map.get(time)));
      return [
        time,
        complete && numbers.every(Number.isFinite)
          ? String(numbers.reduce((a, b) => a + b, 0))
          : "NaN"
      ];
    });
    return { metric: { ...entry.metric, operation, ranking: "diagnostic_range_activity" }, values };
  });
  const selected = new Map<string, Set<string>>();
  for (const runId of new Set(aggregated.map((row) => row.metric.run_id))) {
    check();
    const byTable = new Map<string, any[]>();
    for (const row of aggregated.filter((row) => row.metric.run_id === runId)) {
      const points = byTable.get(row.metric.table) ?? [];
      points.push(...row.values);
      byTable.set(row.metric.table, points);
    }
    const scores = [...byTable]
      .filter(([name]) => name.toLowerCase() !== "other")
      .map(([table, values]) => ({
        metric: { table },
        values:
          view === "total"
            ? [
                [
                  end / 1000,
                  values.every((p) => Number.isFinite(Number(p[1])))
                    ? String(values.reduce((sum, p) => sum + Number(p[1]), 0))
                    : "NaN"
                ]
              ]
            : values
      }));
    const names = orderRankedSeries(scores, view)
      .filter((row) =>
        row.values.some((p: any) => Number.isFinite(Number(p[1])) && Number(p[1]) > 0)
      )
      .slice(0, 10)
      .map((row) => row.metric.table);
    selected.set(runId, new Set(names));
  }
  const output: any[] = [],
    remainders = new Map<string, any[]>();
  for (const row of aggregated) {
    if (selected.get(row.metric.run_id)!.has(row.metric.table)) {
      output.push(row);
      continue;
    }
    const metric = { ...row.metric };
    delete metric.table;
    const key = JSON.stringify(Object.entries(metric).sort(([a], [b]) => a.localeCompare(b)));
    const remainder = remainders.get(key) ?? [];
    remainder.push(row);
    remainders.set(key, remainder);
  }
  for (const contributors of remainders.values()) {
    const points = contributors[0].values,
      maps = contributors.map((row) => new Map<number, string>(row.values));
    const values = points.map(([time]: [number, string]) => {
      check();
      const numbers = maps.map((map) => Number(map.get(time)));
      return [
        time,
        numbers.every(Number.isFinite) ? String(numbers.reduce((a, b) => a + b, 0)) : "NaN"
      ];
    });
    // Keep a verified all-zero result visible when there are no active tables.
    // Missing observations remain NaN; individual zero-activity tables stay excluded.
    if (
      selected.get(contributors[0].metric.run_id)?.size === 0 ||
      values.some((p: any) => !Number.isFinite(Number(p[1])) || Number(p[1]) !== 0)
    )
      output.push({
        metric: {
          ...contributors[0].metric,
          table: "Other",
          display_remainder: "true",
          coverage_model: "diagnostic_prometheus",
          coverage_status: "not_evaluated"
        },
        values
      });
  }
  const clipped = output.map((row) => {
    const values = row.values.filter(([time]: any) => time * 1000 >= start && time * 1000 <= end);
    return {
      metric: row.metric,
      ...(instant
        ? { value: [end / 1000, (view === "total" ? row.values : values).at(-1)?.[1] ?? "NaN"] }
        : { values })
    };
  });
  return orderRankedSeries(clipped, view);
}

// Legacy query helper retained for existing saved-snapshot integrations; dashboard ranks use canonical samples.
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const literal = (s: string) => JSON.stringify(s);
const caches = new WeakMap<PromQuery, Map<string, { names: string[]; expires: number }>>();
const MAX_CACHE = 128;
export interface RankedQuery {
  runId: string;
  operation: string;
  phase: string;
  start: number;
  end: number;
  chartStart: number;
  chartEnd: number;
  stepSeconds: number;
  view: "rate" | "total";
  instant: boolean;
  shiftMs?: number;
  timeline?: RunTimeline;
}
export type PromQuery = (
  path: string,
  params: URLSearchParams,
  method?: "GET" | "POST"
) => Promise<any>;
export async function rankedTableQuery(input: RankedQuery, upstream: PromQuery): Promise<any[]> {
  const { runId, operation, phase, start, end, view } = input;
  let cache = caches.get(upstream);
  if (!cache) {
    cache = new Map();
    caches.set(upstream, cache);
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 31 * 86400_000
  )
    throw new Error("table_rank_window_invalid");
  if (!["read", "create", "update", "delete", "write", "os_read"].includes(operation))
    throw new Error("table_rank_operation_invalid");
  const op =
    operation === "write" ? 'operation=~"create|update|delete"' : `operation=${literal(operation)}`;
  const continuous = input.timeline?.continuousMetrics;
  const base = `run_id=${literal(runId)},phase=~${literal(continuous ? `(${phase})|^$` : phase)},${op}`;
  const metric = "parkbench_openedge_db_table_operations_total";
  const key = JSON.stringify([runId, operation, phase, start, end]);
  let names = (cache.get(key)?.expires ?? 0) > Date.now() ? cache.get(key)!.names : undefined;
  const range = `${Math.max(1, Math.round(end - start))}ms`;
  const phasePattern = new RegExp(`^(?:${phase})$`);
  const windows =
    continuous && !["warmup", "measurement", "cooldown"].every((p) => phasePattern.test(p))
      ? input
          .timeline!.phases.filter((span) => phasePattern.test(span.phase))
          .map((span) => ({
            start: Math.max(start, span.start),
            end: Math.min(end, span.end ?? end)
          }))
          .filter((span) => span.end > span.start)
      : [{ start, end }];
  if (!windows.length) return [];
  const score = (selector: string) =>
    windows
      .map(
        (window) =>
          `sum by (table) (increase(${metric}{${base}${selector}}[${Math.max(1, Math.round(window.end - window.start))}ms] @ ${window.end / 1000}))`
      )
      .join(" + ");
  if (!names) {
    const labels = await upstream(
      "label/table/values",
      new URLSearchParams({
        "match[]": `${metric}{${base}}`,
        start: String(start / 1000),
        end: String(end / 1000)
      }),
      "GET"
    );
    const candidates: string[] = labels.data ?? [];
    if (
      !Array.isArray(candidates) ||
      candidates.length > 100_000 ||
      candidates.some((n) => typeof n !== "string" || Buffer.byteLength(n) > 4096)
    )
      throw new Error("table_rank_inventory_budget_exceeded");
    const selector = new TableRankSelector();
    for (let offset = 0; offset < candidates.length; offset += 128) {
      const filter = candidates
        .slice(offset, offset + 128)
        .map(escapeRegex)
        .join("|");
      const body = await upstream(
        "query",
        new URLSearchParams({
          query: score(`,table=~${literal(filter)}`),
          time: String(end / 1000)
        })
      );
      for (const row of body.data?.result ?? [])
        selector.add(row.metric?.table, row.value ? Number(row.value[1]) : null);
    }
    names = selector.names();
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
    cache.set(key, { names, expires: Date.now() + 300_000 });
  }
  const regex = names.map(escapeRegex).join("|");
  const expression = (filter: string) =>
    view === "total"
      ? score(filter)
      : `sum by (table) (rate(${metric}{${base}${filter}}[${Math.max(1, input.stepSeconds * 2)}s]))`;
  const params = (query: string) =>
    input.instant
      ? new URLSearchParams({ query, time: String(input.chartEnd / 1000) })
      : new URLSearchParams({
          query,
          start: String(input.chartStart / 1000),
          end: String(input.chartEnd / 1000),
          step: String(input.stepSeconds)
        });
  let result: any[] = [];
  if (names.length) {
    const body = await upstream(
      input.instant ? "query" : "query_range",
      params(expression(`,table=~${literal(regex)}`))
    );
    result.push(...(body.data?.result ?? []));
  }
  const remaining = await upstream(
    input.instant ? "query" : "query_range",
    params(`sum(${expression(names.length ? `,table!~${literal(regex)}` : "")})`)
  );
  // The genuine collected 'other' bucket stays in this complementary expression exactly once.
  for (const series of remaining.data?.result ?? []) {
    const points = series.values ?? (series.value ? [series.value] : []);
    if (!points.some(([, value]: [number, string]) => Number(value) !== 0)) continue;
    result.push({
      ...series,
      metric: {
        ...series.metric,
        table: "Other",
        display_remainder: "true",
        coverage_model: "diagnostic_prometheus",
        coverage_status: "not_evaluated"
      }
    });
  }
  if (continuous && view === "rate")
    result = continuousPhaseQuery(`${metric}{phase=~${literal(phase)}}`, input.timeline!).filter({
      data: { result }
    }).data.result;
  for (const row of result) {
    row.metric = { ...row.metric, run_id: runId, operation, ranking: "diagnostic_range_activity" };
    if (input.shiftMs) {
      if (row.values)
        row.values = row.values.map(([t, v]: [number, string]) => [t - input.shiftMs! / 1000, v]);
      if (row.value) row.value = [row.value[0] - input.shiftMs / 1000, row.value[1]];
    }
  }
  return orderRankedSeries(result, view);
}
