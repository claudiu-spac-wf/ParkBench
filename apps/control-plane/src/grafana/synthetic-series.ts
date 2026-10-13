import { ALIGNED_ANCHOR_MS, Mode } from "./alignment";
import { effectiveEnd, RunTimeline } from "./run-timeline";

export interface SeriesPoint {
  metric: Record<string, string>;
  /** [epochMs, value] pairs. */
  points: Array<[number, number]>;
}

export interface SyntheticRequest {
  metric: string;
  timelines: RunTimeline[];
  mode: Mode;
  /** Range queries: start/end/step in ms. Instant queries: start = end = time, step = 0. */
  start: number;
  end: number;
  step: number;
  windowStart?: number;
  windowEnd?: number;
  noticeKind?: "time_range" | "excluded_runs";
  excluded?: string[];
  mismatch?: Mode;
  now?: number;
}

function boundaries(timeline: RunTimeline, now: number) {
  const output: Array<{ phase: string; edge: "start" | "end"; at: number }> = [];
  for (const span of timeline.phases) {
    output.push({ phase: span.phase, edge: "start", at: span.start });
    if (span.end !== undefined && span.end <= now)
      output.push({ phase: span.phase, edge: "end", at: span.end });
  }
  return output;
}

/** Places a boundary on the first step at or after it, so Grafana draws it as a point. */
function onStep(at: number, start: number, end: number, step: number): number | undefined {
  if (step <= 0) return at >= start - 1 && at <= end + 1 ? end : undefined;
  if (at < start || at > end) return undefined;
  return start + Math.ceil((at - start) / step) * step;
}

/** Serves the synthetic series of grafana-runs-datasource.v1 from the run store. */
export function syntheticSeries(request: SyntheticRequest): SeriesPoint[] {
  const now = request.now ?? Date.now();
  const { start, end, step } = request;
  switch (request.metric) {
    case "parkbench_run_phase_boundary":
      return request.timelines.flatMap((timeline) => {
        const shift = request.mode === "aligned" ? timeline.measurementStart : undefined;
        if (request.mode === "aligned" && shift === undefined) return [];
        return boundaries(timeline, now).flatMap((boundary) => {
          const at = shift === undefined ? boundary.at : ALIGNED_ANCHOR_MS + boundary.at - shift;
          const t = onStep(at, start, end, step);
          return t === undefined
            ? []
            : [
                {
                  metric: {
                    __name__: request.metric,
                    run_id: timeline.runId,
                    phase: boundary.phase,
                    edge: boundary.edge
                  },
                  points: [[t, 1] as [number, number]]
                }
              ];
        });
      });
    case "parkbench_run_window":
      return request.timelines
        .filter((t) => t.startedAt !== undefined)
        .flatMap((timeline) => {
          const realEnd = effectiveEnd(timeline, now),
            missing = request.mode === "aligned" && timeline.measurementStart === undefined;
          const shift =
            request.mode === "aligned" && !missing
              ? timeline.measurementStart! - ALIGNED_ANCHOR_MS
              : 0;
          const from = request.windowStart ?? start,
            to = request.windowEnd ?? end;
          if (!missing && (timeline.startedAt! - shift > to || realEnd - shift < from)) return [];
          return [
            {
              metric: {
                __name__: request.metric,
                run_id: timeline.runId,
                start_ms: String(timeline.startedAt),
                end_ms: String(realEnd),
                mode: request.mode,
                excluded: String(missing),
                ...(missing ? { reason: "missing_measurement_anchor" } : {})
              },
              points: [[end, timeline.startedAt!] as [number, number]]
            }
          ];
        });
    case "parkbench_run_notice_text": {
      const empty = !request.timelines.length,
        excluded = request.excluded ?? [];
      const active =
        empty ||
        (request.noticeKind === "time_range" ? Boolean(request.mismatch) : excluded.length > 0);
      const status = empty
        ? "Choose runs to see comparison notices."
        : request.noticeKind === "time_range"
          ? request.mismatch
            ? `The time range does not match the selected runs. Reset the range to ${request.mismatch === "aligned" ? "elapsed time since measurement start" : "the run's clock time"}.`
            : `Time range matches the selected runs (${request.mode === "aligned" ? "elapsed time" : "clock time"}).`
          : excluded.length
            ? `Excluded from aligned charts: no measurement phase (${excluded.join(", ")}).`
            : "No runs are excluded from aligned charts.";
      // Grafana retains a query variable's previous value when refreshing fails.
      // Bind every message to its checked scope so retained text cannot silently
      // present a previous selection/range as the current healthy state.
      const scope = empty ? "" : ` Last successful check for runs ${request.timelines.map(t => t.runId).sort().join(", ")} and range ${new Date(request.windowStart ?? start).toISOString()} to ${new Date(request.windowEnd ?? end).toISOString()}.`;
      const message = status + scope;
      return [
        {
          metric: {
            __name__: request.metric,
            kind: request.noticeKind!,
            message,
            active: String(active),
            ...(excluded.length ? { affected_run_ids: excluded.join(",") } : {})
          },
          points: [[end, active ? 1 : 0]]
        }
      ];
    }
    case "parkbench_run_alignment_excluded":
      return (request.excluded ?? []).map((runId) => ({
        metric: { __name__: request.metric, run_id: runId },
        points: [[end, 1]]
      }));
    case "parkbench_run_mode_mismatch":
      return request.mismatch
        ? [{ metric: { __name__: request.metric, expected: request.mismatch }, points: [[end, 1]] }]
        : [];
    default:
      return [];
  }
}
