import type { ActionRecord } from "./repository";
import type { Repositories } from "../../db/repositories";
import type { HistoricalSummaryWorker } from "../../runs/historical-summary-worker";
import type { RunCoordinator } from "../../runs/coordinator";
import type { ControlUiService } from "../../control-ui/service";
import type { PrometheusMetricBuffer } from "../../../../../packages/metrics/src/prometheus-client";
import type { FileDiscovery } from "../../../../../packages/metrics/src/discovery";
import type { ExperimentMetricAdmin } from "../../../../../packages/metrics/src/prometheus-admin";
import { removeOwnedResources } from "./ownership-manifest";
export interface QuiescenceRuntime {
  repositories: Repositories;
  summaryWorker: HistoricalSummaryWorker;
  coordinator: RunCoordinator;
  controlUi: ControlUiService;
  observerMetrics: PrometheusMetricBuffer;
  targetDiscovery: FileDiscovery;
  metricAdmin: ExperimentMetricAdmin;
  testMode: boolean;
  hostDispatcher: import("../../execution/host-dispatcher").HostDispatcher;
}
export async function quiesceAction(
  action: ActionRecord,
  runtime: QuiescenceRuntime
): Promise<void> {
  const manifest = action.manifest;
  if (!manifest || !action.experimentId) throw new Error("experiment_cleanup_context_missing");
  if (
    runtime.coordinator.isExperimentActive(action.experimentId) ||
    runtime.controlUi.isDispatching(action.experimentId)
  )
    throw new Error("experiment_active");
  runtime.controlUi.pauseExperiment(action.experimentId);
  for (const runId of manifest.runIds)
    runtime.repositories.client.db
      .prepare(
        "UPDATE run_comparison_summaries SET status='UNAVAILABLE',attempt_token=lower(hex(randomblob(16))),lease_until=0,document=NULL,reason_code='experiment_cleanup',retryable=0 WHERE run_id=?"
      )
      .run(runId);
  await runtime.summaryWorker.cancelRuns(manifest.runIds);
  runtime.coordinator.forgetExperiment(action.experimentId);
  runtime.observerMetrics.removeRuns(manifest.runIds);
  for (const id of manifest.runIds) runtime.targetDiscovery.remove(id);
  if (!runtime.testMode) await removeOwnedResources(manifest);
  await runtime.metricAdmin.quiesce(manifest.runIds);
  const claim = runtime.hostDispatcher.repository.currentClaim();
  if (claim?.kind === "EXPERIMENT" && claim.owner_id === action.experimentId)
    runtime.hostDispatcher.release(claim.token);
}
