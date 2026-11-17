import { analyzeRunScope } from "../../grafana/run-scope";
import { removeExperiment, removeComparisonMembers } from "./remove";
import fs from "node:fs";
import path from "node:path";
import type { Platform } from "../../platform";
import { ActionRepository, ActionRecord } from "./repository";
import { ActionWorker } from "./worker";
import { captureSavedSchedule } from "./saved-schedule";
import { captureOwnership, removeOwnedFiles } from "./ownership-manifest";
import { quiesceAction } from "./quiescence";
import { resetExperiment } from "./reset";
import { invalidateRerunComparisons } from "./comparisons";
import {
  validateActionRequest,
  validateActionRetry,
  requireActionKey,
  ActionView
} from "../../../../../packages/contracts/src/experiment-action";
import type { ExperimentMetricAdmin } from "../../../../../packages/metrics/src/prometheus-admin";
import { ownedMetricSelectors } from "../../../../../packages/metrics/src/prometheus-admin";
import type { FileDiscovery } from "../../../../../packages/metrics/src/discovery";
import { TERMINAL_STATES } from "../../../../../packages/contracts/src/run-state";
import { assertScenarioArchiveCompatible } from "../../catalog/archive-contents";
import { verifyMetricRevisionCapability } from "./prerequisites";
import { invalidateNativeQueryCaches } from "../../grafana/native-query-budget";
import { invalidateTableRankingCache } from "../../grafana/table-ranking";
import { checkReadableSeedDirectory } from "../../../../../packages/compose-runner/src/input-checks";
import { runActionFenced, runExecutionRevision } from "../../db/execution";
export interface ActionRuntime {
  repositories: Platform["repositories"];
  controlUi: Platform["controlUi"];
  coordinator: Platform["coordinator"];
  summaryWorker: Platform["summaryWorker"];
  observerMetrics: Platform["observerMetrics"];
  targetDiscovery: FileDiscovery;
  metricAdmin: ExperimentMetricAdmin;
  storage: Platform["storage"];
  config: Platform["config"];
  metricsAvailability: Platform["metricsAvailability"];
  testMode: boolean;
  supportImages: Platform["supportImages"];
  hostDispatcher: Platform["hostDispatcher"];
}
interface Reader {
  runs: Set<string>;
  close: () => void;
}
export class ExperimentActionService {
  readonly repository: ActionRepository;
  readonly worker: ActionWorker;
  readonly metricAdmin: ExperimentMetricAdmin;
  private readers = new Set<Reader>();
  private receiptTimer: ReturnType<typeof setInterval>;
  constructor(private runtime: ActionRuntime) {
    this.repository = new ActionRepository(runtime.repositories.client);
    this.metricAdmin = runtime.metricAdmin;
    this.worker = new ActionWorker(this.repository, {
      validate: (a) => this.validate(a),
      quiesce: async (a) => {
        this.closeReaders(a.manifest.runIds);
        invalidateNativeQueryCaches(a.manifest.runIds);
        invalidateTableRankingCache();
        runtime.metricsAvailability.invalidate(a.manifest.runIds);
        await quiesceAction(a, runtime);
      },
      invalidateComparisons: async (a) => {
        if (a.kind === "RERUN") invalidateRerunComparisons(runtime.repositories, a);
        else removeComparisonMembers(runtime.repositories, a);
        this.repository.save(a);
      },
      deleteMetrics: async (a) => {
        await this.metricAdmin.delete(a.metricScope!);
        const times =
          a.capsule?.runs
            ?.map((r: any) => Date.parse(r.environment.createdAt ?? r.row.created_at ?? "") / 1000)
            .filter(Number.isFinite) ?? [];
        await this.metricAdmin.verify(
          a.metricScope!,
          times.length ? { start: Math.min(...times) } : {}
        );
        const finalScope = await this.metricAdmin.inventory(a.experimentId!, a.manifest.runIds, {
          runScope: !!a.runId
        });
        await this.metricAdmin.verify(finalScope);
      },
      deleteFiles: async (a) => {
        await removeOwnedFiles(a.manifest);
      },
      finalize: (a) =>
        a.kind === "RERUN"
          ? resetExperiment(runtime.repositories, a)
          : removeExperiment(runtime.repositories, a),
      afterComplete: () => runtime.controlUi.wakeExecutionQueue()
    });
    this.repository.purgeReceipts();
    this.receiptTimer = setInterval(() => this.repository.purgeReceipts(), 60000);
    this.receiptTimer.unref();
  }
  private active(id: string): boolean {
    return (
      this.runtime.coordinator.isExperimentActive(id) ||
      this.runtime.controlUi.isDispatching(id) ||
      this.runtime.repositories
        .listRuns(id)
        .some((r) => r.state !== "QUEUED" && !TERMINAL_STATES.includes(r.state))
    );
  }
  eligibility(id: string): any {
    const revision = this.repository.currentRevision(id),
      experiment = this.runtime.repositories.getExperiment(id)!;
    const runs = this.runtime.repositories.listRuns(id),
      pending = this.repository.pending().find((a) => a.experimentId === id);
    const reasons: string[] = [];
    if (this.active(id)) reasons.push("experiment_active");
    if (pending) reasons.push("experiment_action_in_progress");
    if (!["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "INTERRUPTED"].includes(experiment.status))
      reasons.push("experiment_not_terminal");
    try {
      captureSavedSchedule(this.runtime.repositories, id);
    } catch {
      reasons.push("experiment_saved_schedule_incomplete");
    }
    return {
      contractVersion: "experiment-action.v1",
      experimentId: id,
      experimentName: (runs[0]?.environmentSnapshot as any)?.scheduleName ?? id,
      executionRevision: revision,
      runCount: runs.length,
      rerun: { allowed: !reasons.length, reasons },
      remove: {
        allowed: !this.active(id) && !pending,
        reasons: reasons.filter((r) =>
          ["experiment_active", "experiment_action_in_progress"].includes(r)
        )
      },
      pendingActionId: pending?.id ?? this.repository.latestFailure(id)?.id
    };
  }
  submit(id: string, body: unknown, keyValue: unknown): ActionView {
    const request = validateActionRequest(body),
      key = requireActionKey(keyValue);
    const previous = this.repository.receiptFor(key, id, request.kind, request.expectedRevision);
    if (previous) return this.repository.view(previous);
    if (this.active(id)) throw Error("experiment_active");
    const eligible = this.eligibility(id);
    const choice = request.kind === "RERUN" ? eligible.rerun : eligible.remove;
    if (!choice.allowed) throw Error(choice.reasons[0]);
    const action = this.repository.reserve(id, request.kind, request.expectedRevision, key);
    action.runCount = eligible.runCount;
    this.repository.save(action);
    this.worker.enqueue(action.id);
    return this.repository.view(action);
  }
  runEligibility(runId: string): any {
    const run = this.runtime.repositories.getRun(runId);
    if (!run) throw Error("run_not_found");
    const pending = this.repository.pending().find((a) => a.experimentId === run.experimentId);
    const reasons: string[] = [];
    if (this.active(run.experimentId)) reasons.push("experiment_active");
    if (pending) reasons.push("experiment_action_in_progress");
    if (!TERMINAL_STATES.includes(run.state)) reasons.push("run_not_terminal");
    try {
      captureSavedSchedule(this.runtime.repositories, run.experimentId, true, runId);
    } catch {
      reasons.push("experiment_saved_schedule_incomplete");
    }
    const failed = this.repository.latestFailure(run.experimentId);
    const current = pending ?? failed;
    return {
      contractVersion: "experiment-action.v1",
      scope: "RUN",
      experimentId: run.experimentId,
      experimentName: (run.environmentSnapshot as any)?.scheduleName ?? run.experimentId,
      runId,
      runName: run.name ?? runId,
      executionRevision: run.executionRevision,
      runCount: 1,
      rerun: { allowed: !reasons.length, reasons },
      remove: { allowed: false, reasons: ["run_removal_unsupported"] },
      pendingActionId:
        current && (!current.runId || current.runId === runId) ? current.id : undefined
    };
  }
  submitRun(runId: string, body: unknown, keyValue: unknown): ActionView {
    const request = validateActionRequest(body),
      key = requireActionKey(keyValue);
    if (request.kind !== "RERUN") throw Error("experiment_action_request_invalid");
    const previous = this.repository.receiptFor(
      key,
      "",
      request.kind,
      request.expectedRevision,
      runId
    );
    if (previous) return this.repository.view(previous);
    const eligibility = this.runEligibility(runId);
    if (!eligibility.rerun.allowed) throw Error(eligibility.rerun.reasons[0]);
    const action = this.repository.reserve(
      eligibility.experimentId,
      "RERUN",
      request.expectedRevision,
      key,
      runId
    );
    action.runCount = 1;
    this.repository.save(action);
    this.worker.enqueue(action.id);
    return this.repository.view(action);
  }
  get(id: string): ActionView {
    const a = this.repository.get(id, false);
    if (!a) throw Error("experiment_action_not_found");
    return this.repository.view(a);
  }
  retry(id: string, body: unknown, key: unknown): ActionView {
    validateActionRetry(body);
    requireActionKey(key);
    const prior = this.repository.get(id);
    if (!prior) throw Error("experiment_action_not_found");
    if (prior.status !== "FAILED") return this.repository.view(prior);
    if (!prior.holdsFence && prior.experimentId && this.active(prior.experimentId))
      throw Error("experiment_active");
    const a = this.repository.retry(id);
    this.worker.enqueue(id);
    return this.repository.view(a);
  }
  listPending(): ActionView[] {
    return this.repository.pending().map((a) => this.repository.view(a));
  }
  idle(): Promise<void> {
    return this.worker.idle();
  }
  recover(): void {
    this.worker.recover();
  }
  close(): Promise<void> {
    clearInterval(this.receiptTimer);
    return this.worker.close();
  }
  private async validate(action: ActionRecord): Promise<Partial<ActionRecord>> {
    const id = action.experimentId!;
    if (this.active(id)) throw Error("experiment_active");
    if (
      (action.runId
        ? runExecutionRevision(this.runtime.repositories.client.db, action.runId)
        : this.repository.currentRevision(id)) !== action.expectedRevision
    )
      throw Error("experiment_revision_stale");
    const capsule =
      action.kind === "RERUN"
        ? captureSavedSchedule(this.runtime.repositories, id, true, action.runId)
        : undefined;
    if (capsule && !this.runtime.testMode) {
      const inputs = JSON.parse(capsule.experiment.inputs);
      try {
        for (const file of [inputs.seed, inputs.applicationArchive])
          fs.accessSync(file, fs.constants.R_OK);
        checkReadableSeedDirectory(inputs.seed);
        assertScenarioArchiveCompatible(
          inputs.applicationArchive,
          JSON.parse(capsule.control.scenario_snapshot)
        );
        await this.runtime.coordinator.validateSavedDatabaseImage(inputs.databaseImage, {
          finite: capsule.runs.some((r) => r.environment.databaseIops.presetId !== "unlimited"),
          writers: true,
          setup: capsule.runs.some((r) => r.environment.databaseSetup?.steps?.length)
        });
      } catch {
        throw Error("experiment_input_unavailable");
      }
    }
    const manifest = captureOwnership(
      this.runtime.repositories,
      id,
      this.runtime.storage.root,
      this.runtime.config.runRoot ?? path.resolve(".parkbench/runs"),
      action.id,
      action.runId
    );
    await this.metricAdmin.preflight();
    if (!this.runtime.testMode)
      await verifyMetricRevisionCapability(
        this.runtime.config.cadvisorUrl ?? "http://cadvisor:8080",
        this.runtime.supportImages.loadgen
      );
    // The first sample of the current execution may still be in an in-flight
    // scrape. Seal its known revision even when inventory has not seen it yet.
    const currentRevisions = manifest.runIds.map((runId) => ({
      runId,
      revision: runExecutionRevision(this.runtime.repositories.client.db, runId)!
    }));
    const knownCurrent = ownedMetricSelectors(
      id,
      manifest.runIds,
      [
        {
          experiment_id: id,
          execution_revision: this.repository.currentRevision(id),
          container_label_parkbench_experiment_id: id,
          container_label_parkbench_execution_revision: this.repository.currentRevision(id)
        },
        ...currentRevisions.map(({ runId: run_id, revision }) => ({
          run_id,
          experiment_id: id,
          execution_revision: revision,
          container_label_parkbench_run_id: run_id,
          container_label_parkbench_experiment_id: id,
          container_label_parkbench_execution_revision: revision
        }))
      ],
      { runScope: !!action.runId }
    );
    const metricScope = [
      ...new Set([
        ...knownCurrent,
        ...(await this.metricAdmin.inventory(id, manifest.runIds, { runScope: !!action.runId }))
      ])
    ].sort();
    return { capsule, manifest, metricScope };
  }
  assertReadable(runIds: string[]): void {
    for (const id of runIds) {
      const run = this.runtime.repositories.getRun(id);
      if (run && runActionFenced(this.runtime.repositories.client.db, id))
        throw Error("experiment_action_in_progress");
    }
  }
  registerRead(request: any, reply: any): void {
    if (!["GET", "POST"].includes(request.method)) return;
    if (request.url.split("?")[0].endsWith("/actions")) return;
    const params = request.params ?? {},
      runs = new Set<string>();
    if (params.runId) runs.add(params.runId);
    if (params.experimentId && !request.url.split("?")[0].endsWith("/actions"))
      this.runtime.repositories.listRuns(params.experimentId).forEach((r) => runs.add(r.id));
    if (params.comparisonId) {
      const comparison = this.runtime.controlUi.resolveComparisonSelection(params.comparisonId);
      if (comparison) {
        if (comparison.baselineRunId) runs.add(comparison.baselineRunId);
        comparison.variantRunIds.forEach((id) => runs.add(id));
      }
    }
    if (params.contextId) {
      const context = this.runtime.controlUi.getDashboard(params.contextId);
      context?.runIds.forEach((id) => runs.add(id));
    }
    // Grafana query routes also carry run IDs in their query parameters.
    for (const [key, value] of Object.entries(request.query ?? {}))
      if (/run(?:_id|Id|Ids|s)?$/.test(key) && typeof value === "string")
        value.split(",").forEach((id) => runs.add(id));
    if (request.url.startsWith("/api/v1/grafana/prom/")) {
      const params = new URLSearchParams(request.url.split("?")[1] ?? "");
      if (typeof request.body === "string")
        new URLSearchParams(request.body).forEach((v, k) => params.append(k, v));
      for (const expression of [...params.getAll("query"), ...params.getAll("match[]")]) {
        const scope = analyzeRunScope(expression);
        if (scope.kind === "scoped" || scope.kind === "synthetic")
          scope.runIds?.forEach((id) => runs.add(id));
      }
    }
    this.assertReadable([...runs]);
    if (!runs.size) return;
    const reader: Reader = { runs, close: () => reply.raw.destroy() };
    this.readers.add(reader);
    const done = () => this.readers.delete(reader);
    reply.raw.once("close", done);
    reply.raw.once("finish", done);
  }
  private closeReaders(runIds: string[]): void {
    for (const r of this.readers)
      if (runIds.some((id) => r.runs.has(id))) {
        r.close();
        this.readers.delete(r);
      }
  }
}
