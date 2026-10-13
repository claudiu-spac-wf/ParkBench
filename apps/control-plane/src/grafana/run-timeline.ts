import { Run } from "../../../../packages/contracts/src/run";

export type PhaseName = "warmup" | "measurement" | "cooldown";

export interface PhaseSpan {
  phase: PhaseName;
  start: number;
  end?: number;
}

/** Run and phase boundaries in epoch milliseconds (data-model RunTimeline). */
export interface RunTimeline {
  runId: string;
  startedAt?: number;
  /** Actual end, or undefined while the run is still in progress. */
  endedAt?: number;
  phases: PhaseSpan[];
  measurementStart?: number;
  continuousMetrics?: boolean;
  nativePublisher?: "endpoint" | "controller";
  nativeRefreshSeconds?: number;
}

export interface RunTimelineSource {
  get(runId: string): RunTimeline | undefined;
  /** All runs, newest first. */
  list(): RunTimeline[];
}

const PHASES: PhaseName[] = ["warmup", "measurement", "cooldown"];

function ms(value?: string): number | undefined {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Only boundaries that were reached are returned. */
export function timelineFromRun(
  run: Pick<Run, "id" | "startedAt" | "finishedAt" | "phaseBoundaries" | "environmentSnapshot">
): RunTimeline {
  const phases: PhaseSpan[] = [];
  for (const phase of PHASES) {
    const boundary = run.phaseBoundaries?.[phase];
    const start = ms(boundary?.startedAt);
    if (start === undefined) continue;
    phases.push({ phase, start, end: ms(boundary?.finishedAt) });
  }
  const startedAt = ms(run.startedAt) ?? phases[0]?.start;
  return {
    runId: run.id,
    continuousMetrics: run.environmentSnapshot?.metricsCollectionMode === "continuous",
    nativePublisher: (run.environmentSnapshot as any)?.sourceCadences?.observers?.find((o:any)=>o.kind==="openedge_db_v1")?.publisher,
    nativeRefreshSeconds: (run.environmentSnapshot as any)?.sourceCadences?.nativeDatabaseRefreshSeconds,
    startedAt,
    endedAt: ms(run.finishedAt),
    phases,
    measurementStart: phases.find((span) => span.phase === "measurement")?.start
  };
}

/** End used for ranges: the actual end, or "now" for a run still in progress. */
export function effectiveEnd(timeline: RunTimeline, now = Date.now()): number {
  return timeline.endedAt ?? now;
}

export function repositoryTimelineSource(repositories: {
  getRun(id: string): Run | undefined;
  listAllRuns?(): Run[];
}): RunTimelineSource {
  return {
    get: (runId) => {
      const run = repositories.getRun(runId);
      return run ? timelineFromRun(run) : undefined;
    },
    list: () =>
      (repositories.listAllRuns?.() ?? [])
        .map(timelineFromRun)
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  };
}
