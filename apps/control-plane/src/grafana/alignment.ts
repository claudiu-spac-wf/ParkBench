import { ALIGNED_ANCHOR_MS } from "../../../../packages/dashboards/src/model";
import { effectiveEnd, RunTimeline } from "./run-timeline";

export { ALIGNED_ANCHOR_MS };

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export type Mode = "clock" | "aligned";

export function modeFor(runCount: number): Mode {
  return runCount > 1 ? "aligned" : "clock";
}

/** True when a range lies on the aligned elapsed-time axis (within a year of the anchor). */
export function isAlignedRange(startMs: number, endMs: number): boolean {
  return (
    Math.abs(startMs - ALIGNED_ANCHOR_MS) <= YEAR_MS &&
    Math.abs(endMs - ALIGNED_ANCHOR_MS) <= YEAR_MS
  );
}

/** Contract R9: which mode the range was meant for, if it disagrees with the run count. */
export function modeMismatch(mode: Mode, startMs: number, endMs: number): Mode | undefined {
  const aligned = isAlignedRange(startMs, endMs);
  if (mode === "aligned" && !aligned) return "aligned";
  if (mode === "clock" && aligned) return "clock";
  return undefined;
}

/** Clock-mode default: run start to run end (or now). */
export function clockRange(
  timelines: RunTimeline[],
  now = Date.now()
): { from: number; to: number } | undefined {
  const starts = timelines.map((t) => t.startedAt).filter((v): v is number => v !== undefined);
  if (!starts.length) return undefined;
  return { from: Math.min(...starts), to: Math.max(...timelines.map((t) => effectiveEnd(t, now))) };
}

/** Aligned-mode default (FR-016a): earliest warmup offset to latest end offset. */
export function alignedRange(
  timelines: RunTimeline[],
  now = Date.now()
): { from: number; to: number } | undefined {
  const aligned = timelines.filter((t) => t.measurementStart !== undefined);
  if (!aligned.length) return undefined;
  const from = Math.min(
    ...aligned.map(
      (t) =>
        Math.min(t.startedAt ?? t.measurementStart!, ...t.phases.map((p) => p.start)) -
        t.measurementStart!
    )
  );
  const to = Math.max(...aligned.map((t) => effectiveEnd(t, now) - t.measurementStart!));
  return {
    from: ALIGNED_ANCHOR_MS + Math.min(0, from),
    to: ALIGNED_ANCHOR_MS + Math.max(to, 1000)
  };
}
