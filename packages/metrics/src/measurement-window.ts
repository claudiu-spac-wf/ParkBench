import { Run } from "../../contracts/src/run";
import { MeasurementWindow } from "../../contracts/src/run-summary";
export function resolveMeasurementWindow(run: Run): MeasurementWindow {
  const phase = run.phaseBoundaries?.measurement;
  const recorded = (run.environmentSnapshot as any)?.measurementWindow;
  if (!phase && !run.measuringAt)
    return { start: null, end: null, state: "not_started", durationSeconds: 0 };
  if (
    !phase?.startedAt ||
    !phase.finishedAt ||
    !Number.isFinite(Date.parse(phase.startedAt)) ||
    !Number.isFinite(Date.parse(phase.finishedAt)) ||
    Date.parse(phase.finishedAt) < Date.parse(phase.startedAt)
  )
    throw new Error("measurement_boundaries_missing");
  return {
    start: phase.startedAt,
    end: phase.finishedAt,
    state:
      recorded?.state === "completed" || recorded?.state === "interrupted"
        ? recorded.state
        : ["INTERRUPTED", "CANCELLED", "FAILED"].includes(run.state)
          ? "interrupted"
          : "completed",
    durationSeconds: (Date.parse(phase.finishedAt) - Date.parse(phase.startedAt)) / 1000
  };
}
