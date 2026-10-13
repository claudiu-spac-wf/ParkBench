import {
  DASHBOARD_UIDS,
  RETIRED_DASHBOARD_UIDS,
  DASHBOARD_CATALOG
} from "../../../../packages/dashboards/src/model";
import { alignedRange, clockRange, isAlignedRange, modeFor } from "./alignment";
import { RunTimeline, RunTimelineSource } from "./run-timeline";

const RUN_SCOPED = new Set<string>(
  DASHBOARD_CATALOG.filter((e) => e.runSelection === "multi").map((e) => e.uid)
);
const PICKER_DASHBOARDS = new Set<string>(
  DASHBOARD_CATALOG.filter((e) => e.runSelection === "picker_time_only").map((e) => e.uid)
);

export interface OpenRedirectDeps {
  grafanaUrl: string;
  timelines: RunTimelineSource;
  now?: () => number;
}

export type OpenResult = { status: 302; location: string } | { status: 400 | 404; error: string };

/** Resolves a dashboard UID, mapping retired v1 UIDs to their replacements. */
export function resolveDashboardUid(uid: string): string | undefined {
  if (RETIRED_DASHBOARD_UIDS[uid]) return RETIRED_DASHBOARD_UIDS[uid];
  return (Object.values(DASHBOARD_UIDS) as string[]).includes(uid) ? uid : undefined;
}

function numeric(value: string | null): number | undefined {
  if (value === null || value === "" || !/^-?\d+(\.\d+)?$/.test(value)) return undefined;
  return Number(value);
}

/** Implements the redirect table of grafana-runs-datasource.v1 §2 (FR-016a, FR-024a). */
export function resolveOpen(params: URLSearchParams, deps: OpenRedirectDeps): OpenResult {
  const now = (deps.now ?? Date.now)();
  const uid = resolveDashboardUid(params.get("dashboard") ?? "");
  if (!uid) return { status: 404, error: "dashboard_not_found" };
  const explicitRuns = [...params.getAll("run_id"), ...params.getAll("var-run_id")].filter(Boolean);
  const pickerRun = params.get("var-picker_run") || params.get("picker_run") || "";
  const runs = [...new Set(explicitRuns.length ? explicitRuns : pickerRun ? [pickerRun] : [])];
  const reset = params.get("reset") === "1";
  const from = params.get("from");
  const to = params.get("to");
  const fromMs = numeric(from);
  const toMs = numeric(to);
  const givenAligned = fromMs !== undefined && toMs !== undefined && isAlignedRange(fromMs, toMs);
  const timelines = runs
    .map((id) => deps.timelines.get(id))
    .filter((t): t is RunTimeline => Boolean(t));
  const query = new URLSearchParams();
  for (const name of ["phase", "replica", "table", "index"])
    for (const value of params.getAll(`var-${name}`)) query.append(`var-${name}`, value);
  const base = `${deps.grafanaUrl.replace(/\/$/, "")}/d/${encodeURIComponent(uid)}`;

  if (RUN_SCOPED.has(uid)) {
    if (!runs.length) return { status: 400, error: "run_required" };
    for (const run of runs) query.append("var-run_id", run);
    const mode = modeFor(runs.length);
    const keep = !reset && from && to && (mode === "aligned") === givenAligned;
    const range = keep
      ? { from, to }
      : mode === "aligned"
        ? alignedRange(timelines, now)
        : clockRange(timelines, now);
    if (range) {
      query.set("from", String(range.from));
      query.set("to", String(range.to));
    }
    return { status: 302, location: `${base}?${query}` };
  }

  if (PICKER_DASHBOARDS.has(uid)) {
    const keepClock = !reset && from && to && !givenAligned;
    if (runs.length === 1) {
      query.set("var-picker_run", runs[0]);
      const range = keepClock ? { from, to } : clockRange(timelines, now);
      if (range) {
        query.set("from", String(range.from));
        query.set("to", String(range.to));
      }
    } else {
      const range = keepClock
        ? { from, to }
        : timelines.length
          ? clockRange(timelines, now)
          : undefined;
      if (range) {
        query.set("from", String(range.from));
        query.set("to", String(range.to));
      }
    }
    return { status: 302, location: query.size ? `${base}?${query}` : base };
  }
  return { status: 404, error: "dashboard_not_found" };
}

export function registerOpenRedirectRoute(app: any, deps: OpenRedirectDeps): void {
  app.get("/api/v1/grafana/open", async (request: any, reply: any) => {
    const url = String(request.raw?.url ?? request.url ?? "");
    const params = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
    const result = resolveOpen(params, deps);
    if (result.status === 302) return reply.code(302).header("location", result.location).send();
    reply.code(result.status);
    return { error: { code: result.error, message: result.error } };
  });
}
