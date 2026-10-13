import { DASHBOARD_UIDS } from "../../../../packages/dashboards/src/model";
import { DashboardContext } from "../../../../packages/contracts/src";
import { Run } from "../../../../packages/contracts/src/run";

const allowedVariables = new Set(["run_id", "experiment_id", "phase"]);

export function deriveDashboardTimeRange(
  runs: Array<Pick<Run, "startedAt" | "measuringAt" | "finishedAt" | "phaseBoundaries">>
): { from: string; to: string } | undefined {
  if (!runs.length) return undefined;
  const starts = runs
    .flatMap((run) => [
      run.startedAt,
      run.measuringAt,
      ...Object.values(run.phaseBoundaries ?? {}).map((boundary) => boundary?.startedAt)
    ])
    .map((timestamp) => Date.parse(timestamp ?? ""))
    .filter(Number.isFinite);
  if (!starts.length) return undefined;

  const finishes = runs.map((run) => Date.parse(run.finishedAt ?? "")).filter(Number.isFinite);
  const allRunsFinished = finishes.length === runs.length;
  return {
    from: new Date(Math.min(...starts)).toISOString(),
    to: allRunsFinished ? new Date(Math.max(...finishes)).toISOString() : "now"
  };
}

export function createDashboardContext(input: {
  id: string;
  experimentId?: string;
  experimentIds?: string[];
  runIds: string[];
  baselineRunId?: string;
  phase?: string;
  metricScope?: string[];
  grafanaAvailable?: boolean;
  expiresAt: string;
}): DashboardContext {
  const runIds = [...new Set(input.runIds)];
  if (input.baselineRunId && !runIds.includes(input.baselineRunId))
    throw new Error("dashboard_baseline_not_in_run_scope");
  const variables: Record<string, string[]> = { run_id: runIds };
  if (input.experimentIds?.length) variables.experiment_id = [...new Set(input.experimentIds)];
  else if (input.experimentId) variables.experiment_id = [input.experimentId];
  if (input.phase) variables.phase = [input.phase];
  if ([...Object.keys(variables)].some((key) => !allowedVariables.has(key)))
    throw new Error("dashboard_variable_forbidden");
  return {
    id: input.id,
    experimentId: input.experimentId,
    runIds,
    baselineRunId: input.baselineRunId,
    phase: input.phase,
    metricScope: input.metricScope ?? ["workload", "pas", "database", "disk_io"],
    dashboardRefs: [
      {
        dashboardId: DASHBOARD_UIDS.summary,
        panelIds: ["legacy.benchmark-overview.1", "legacy.benchmark-overview.2", "rs.db_cpu"]
      }
    ],
    variables,
    availability: input.grafanaAvailable === false ? "unavailable" : "available",
    expiresAt: input.expiresAt
  };
}
