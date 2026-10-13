import { resolveFreshStartupFiles } from "../../../../packages/compose-runner/src/input-checks";
import { canonicalParameterValues } from "../../../../packages/contracts/src/matrix-expansion";
import { validateScenarioParameterValues } from "../../../../packages/contracts/src/scenario-parameter-validation";
import {
  databaseParameterOptions,
  databaseParameterDefinition,
  databaseParameterInput,
  validateDatabaseParameterConfiguration,
  validateDatabaseParameterPaths,
  DATABASE_PARAMETER_REGISTRY_VERSION
} from "../../../../packages/contracts/src/database-parameter-options";
import { persistRunContext } from "./run-context";
import {
  resolveDatabaseRunControls,
  validateDatabaseRunControls
} from "../../../../packages/contracts/src/database-run-controls";
import fs from "node:fs";
import path from "node:path";
import { signalCancellation } from "./cancellation";
import {
  Experiment,
  ExperimentRequest,
  Variant
} from "../../../../packages/contracts/src/experiment";
import { Run } from "../../../../packages/contracts/src/run";
import { isTerminal } from "../../../../packages/contracts/src/run-state";
import { Scenario } from "../../../../packages/contracts/src/scenario";
import {
  DATABASE_LATENCY_APPLY_FAILED,
  DATABASE_LATENCY_CONTRACT_VERSION,
  DATABASE_LATENCY_UNSUPPORTED,
  DatabaseLatencyEvidence,
  notRequestedLatencyEvidence
} from "../../../../packages/contracts/src/database-latency";
import { databaseLatencyOf } from "../../../../packages/contracts/src/run-parameters";
import { DatabaseRunControlsError } from "../../../../packages/compose-runner/src/database-run-controls-evidence";
import { DatabaseLatencyError } from "../../../../packages/compose-runner/src/orchestrator";
import { OPENEDGE_WORKLOAD_TIMEOUT_MS } from "../../../../packages/contracts/src/openedge";
import {
  privateInputValues,
  redactSecrets,
  runtimeSecretValues
} from "../../../../packages/contracts/src/redaction";
import { Repositories } from "../db/repositories";
import { RunStateMachine } from "./state-machine";
import { classifyRunError } from "./run-error";
import { Finalizer } from "./finalizer";
import { ArtifactService } from "../artifacts/service";
import {
  generateRunCompose,
  ownershipLabels,
  ComposeBundle,
  RunOrchestrator
} from "../../../../packages/compose-runner/src";
import {
  buildRunLabels,
  calculateCompleteness,
  calculateRequiredMeasurementGaps,
  DISK_IO_QUERIES,
  readRawChunks,
  finalizationQueryOptions,
  recordVerificationQuery,
  metricSeries,
  measurementStatistics
} from "../../../../packages/metrics/src";
import { MetricSink, PrometheusClient } from "../../../../packages/metrics/src/prometheus-client";
import { ObserverCollector, ObserverFactory } from "../../../../packages/observers/src";
import { phaseSchedule } from "./phase-runner";
import { FileDiscovery } from "../../../../packages/metrics/src/discovery";
import { effectiveConfiguration } from "../experiments/effective-config";
import { saveDiagnostics } from "../artifacts/diagnostics";
import {
  checkCredentialReference,
  checkImageReference,
  checkInputReference,
  checkReadableFile,
  checkReadableSeedDirectory,
  inspectSeedStartupFile,
  checkRunRootSpace
} from "../../../../packages/compose-runner/src/input-checks";
import { shouldStopMatrix } from "../experiments/failure-policy";
import { aggregateExperimentStatus } from "../experiments/status";
import { classifyLoadgenExitCode } from "./failure-classifier";
import { composeProjectName } from "../../../../packages/compose-runner/src/project-name";
import { MetricSample } from "../../../../packages/contracts/src/metrics";
import type { Coverage } from "../../../../packages/contracts/src/metric-definitions";
import { nextRunNames } from "./run-numbering";
import { allocateNumberedRunId, allocateNameDerivedId } from "./name-derived-id";
import type { ParkBenchConfig } from "../../../../packages/contracts/src/config";
import {
  validateBenchmarkImageManifest,
  validateWorkScenario,
  workProcedureNames
} from "../../../../packages/contracts/src/openedge-validation";
import {
  checkContractAgainstSeed,
  validateWorkloadContract
} from "../../../../packages/contracts/src/workload-contract";
import { imageIdentitySnapshot } from "../../../../packages/contracts/src/image-reference";
import {
  validateOpenEdgeDbParameterCapture,
  OpenEdgeDbParameterCapture
} from "../../../../packages/contracts/src/openedge-db-parameter-capture";
import { deriveDatabaseParameterSnapshot } from "../../../../packages/observers/src/openedge-db/parameter-snapshot";
import { parameterSnapshotSamples } from "../../../../packages/observers/src/openedge-db/parameter-metrics";
import { resolveDatabaseStartup } from "../../../../packages/contracts/src/matrix-expansion";
import { assertScenarioArchiveCompatible } from "../catalog/archive-contents";
import {
  validateDatabaseStartupParameters,
  DatabaseStartupParameters
} from "../../../../packages/contracts/src/database-startup";
import {
  DATABASE_BROKER_PARAMETERS,
  validateBrokerParameter
} from "../../../../packages/compose-runner/src/startup-file";

export interface RunBehavior {
  terminalState?: Run["state"];
  missingRequiredObserver?: boolean;
  exportFailure?: boolean;
  readinessFailure?: boolean;
}

export interface RunCoordinatorOptions {
  testMode?: boolean;
  orchestrator: RunOrchestrator;
  observerFactory: ObserverFactory;
  phaseScale: number;
  requiredDiskIo?: boolean;
  targetDiscovery?: FileDiscovery;
  /** Reachable owner of the run-scoped cAdvisor proxy (standalone smoke). */
  runCAdvisorTarget?: () => string;
  observerMetrics?: MetricSink;
  observerSamplingIntervalSeconds?: number;
  cadvisorHousekeepingSeconds?: number;
  supportImages?: { loadgen: string; observer: string };
  requirePinnedSupportImages?: boolean;
  observerSupports?: (kind: string) => boolean;
  observerValidate?: (declaration: any) => void;
  inputRoot?: string;
  /** Workload discovery root (`Workloads/...` procedures and their `.contract.json` files). */
  workloadsRoot?: string;
  /** Configured seeds root; seeds may sit there even when it is outside the input root. */
  seedsRoot?: string;
  /** Where run folders are created; checked for room for one more seed copy before provisioning. */
  runRoot?: string;
  openedge?: ParkBenchConfig["openedge"];
  parameterCapture?: (run: Run, bundle: ComposeBundle) => Promise<OpenEdgeDbParameterCapture>;
  requireParameterCapture?: boolean;
}

export class RunCoordinator {
  private activeExperiment?: string;
  private readonly experimentFinishedListeners = new Set<() => void>();
  private readonly cancellationRequests = new Set<string>();
  private readonly activeRuns = new Map<string, ComposeBundle>();

  constructor(
    private readonly repositories: Repositories,
    private readonly finalizer: Finalizer,
    private readonly artifacts: ArtifactService,
    private readonly prometheus: PrometheusClient,
    private readonly behavior = new Map<string, RunBehavior>(),
    private readonly options: RunCoordinatorOptions
  ) {}

  setBehavior(runId: string, behavior: RunBehavior): void {
    this.behavior.set(runId, behavior);
  }

  onExperimentFinished(listener: () => void): () => void {
    this.experimentFinishedListeners.add(listener);
    return () => this.experimentFinishedListeners.delete(listener);
  }

  createExperiment(
    request: ExperimentRequest,
    scenario: Scenario,
    reviewed?: { base: string; names: string[] }
  ): Experiment {
    let staticObserverFailure: ReturnType<typeof classifyRunError> = undefined;
    const machine = new RunStateMachine(this.repositories);
    try {
      this.validateOpenEdgeManifest(request, scenario);
      for (const observer of scenario.observers) this.options.observerValidate?.(observer);
      for (const observer of scenario.observers)
        if (observer.required && this.options.observerSupports?.(observer.kind) === false)
          throw new Error(`observer_adapter_unavailable:${observer.kind}`);
    } catch (error) {
      staticObserverFailure = classifyRunError(error);
      if (!staticObserverFailure || staticObserverFailure.failureKind !== "observer") throw error;
    }
    checkImageReference(request.inputs.databaseImage);
    checkImageReference(request.inputs.pasImage);
    if (this.options.requirePinnedSupportImages) {
      checkImageReference(this.options.supportImages?.loadgen ?? "");
      checkImageReference(this.options.supportImages?.observer ?? "");
    }
    checkCredentialReference(request.inputs.credentialRef);
    const inputProvenance = [
      checkInputReference(request.inputs.seed, "seed", [
        this.options.inputRoot ?? process.cwd(),
        this.options.seedsRoot
      ]),
      checkInputReference(
        request.inputs.applicationArchive,
        "application_archive",
        this.options.inputRoot ?? process.cwd()
      )
    ];
    const scenarioDefaults = Object.fromEntries(
      (scenario.parameterDefinitions ?? [])
        .filter((definition) => definition.defaultValue !== undefined)
        .map((definition) => [definition.canonicalName, definition.defaultValue!])
    ) as Record<string, string | number | boolean>;
    const variants = request.variants.map((providedVariant) => {
      const variant = {
        ...providedVariant,
        parameters: canonicalParameterValues(providedVariant.parameters)
      };
      const seedName =
        !request.inputs.seed.startsWith("input:") &&
        fs.existsSync(request.inputs.seed) &&
        fs.statSync(request.inputs.seed).isDirectory()
          ? checkReadableSeedDirectory(request.inputs.seed).databaseName
          : variant.databaseStartup?.databaseName;
      const freshStartup = reviewed
        ? variant.databaseStartup
        : resolveFreshStartupFiles(
            request.inputs.seed,
            scenarioDefaults,
            variant.parameters,
            variant.databaseStartup,
            seedName
          );
      const startupVariant = freshStartup ? { ...variant, databaseStartup: freshStartup } : variant;
      const databaseStartup = normalizedDatabaseStartup(startupVariant, scenarioDefaults);
      if (databaseStartup) {
        databaseStartup.registryVersion = DATABASE_PARAMETER_REGISTRY_VERSION;
        const values = Object.fromEntries(
          databaseStartup.parameters.map((p) => [
            p.name,
            databaseParameterInput(p.name, p.displayValue)
          ])
        );
        validateDatabaseParameterConfiguration(
          values,
          databaseParameterOptions({
            version: this.options.openedge?.version,
            features: this.options.openedge?.databaseFeatures
          })
        );
        validateDatabaseParameterPaths(values, databaseStartup.databaseName);
      }
      validateScenarioParameterValues(
        scenario.parameterDefinitions ?? [],
        {
          ...scenarioDefaults,
          ...variant.parameters,
          ...Object.fromEntries(
            (databaseStartup?.parameters ?? []).map((p) => [
              p.name,
              databaseParameterInput(p.name, p.displayValue)
            ])
          )
        },
        {
          version:
            this.options.openedge?.version ?? (this.options.testMode ? "12.8.11" : "unverified"),
          features: this.options.openedge?.databaseFeatures
        }
      );
      const resolvedControls = resolveDatabaseRunControls(scenarioDefaults, variant.parameters, {
        version:
          this.options.openedge?.version ?? (this.options.testMode ? "12.8.11" : "unverified"),
        features: this.options.openedge?.databaseFeatures
      });
      // createExperiment creates new records; replay executes already frozen runs separately.
      const databaseRunControls = {
        ...(variant.databaseRunControls
          ? validateDatabaseRunControls(variant.databaseRunControls)
          : resolvedControls),
        requirements: { namedLatchRequired: true, observerProtocolVersion: 4 }
      };
      if (
        databaseRunControls.apwCount !== resolvedControls.apwCount ||
        databaseRunControls.biwEnabled !== resolvedControls.biwEnabled ||
        JSON.stringify(databaseRunControls.biCluster) !== JSON.stringify(resolvedControls.biCluster)
      )
        throw new Error("database_run_control_invalid:snapshot_parameter_conflict");
      return {
        ...variant,
        parameters: { ...scenarioDefaults, ...variant.parameters },
        ...(databaseStartup ? { databaseStartup } : {}),
        databaseRunControls
      };
    });
    const scheduleName = request.scheduleName ?? scenario.id;
    const allocated = new Set<string>();
    const allocate = (): string => {
      const value = allocateNameDerivedId(
        scheduleName,
        (candidate) => allocated.has(candidate) || this.repositories.hasNamedId(candidate)
      );
      allocated.add(value);
      return value;
    };
    const experiment: Experiment = {
      ...request,
      variants,
      id: allocate(),
      status: staticObserverFailure ? "FAILED" : "QUEUED",
      runIds: [],
      createdAt: new Date().toISOString()
    };
    this.repositories.client.db.exec("SAVEPOINT parkbench_create_experiment");
    try {
      const numbered = nextRunNames(
        this.repositories,
        reviewed?.base ?? scheduleName,
        variants.length * request.repetitions
      );
      if (
        reviewed &&
        (reviewed.names.length !== numbered.length ||
          reviewed.names.some((name, i) => name !== numbered[i].name))
      )
        throw new Error("run_name_conflict_repreview");
      let numberIndex = 0;
      this.repositories.saveExperiment(experiment);
      for (const variant of variants)
        for (let repetition = 1; repetition <= request.repetitions; repetition++) {
          const identity = numbered[numberIndex++];
          const id = allocateNumberedRunId(
            identity.base,
            identity.number,
            (candidate) => allocated.has(candidate) || this.repositories.hasNamedId(candidate)
          );
          allocated.add(id);
          const effective = effectiveConfiguration(
            { scenario: scenario.id, scenarioVersion: scenario.version },
            variant
          );
          const run: Run = {
            id,
            name: identity.name,
            experimentId: experiment.id,
            variantId: variant.id,
            repetition,
            state: "QUEUED",
            measurementValidity: "PENDING",
            composeProject: composeProjectName(id),
            resourceNamespace: ownershipLabels(id, experiment.id, "run"),
            environmentSnapshot: {
              runName: identity.name,
              runNumber: identity.number,
              runNameBase: identity.base,
              scenario,
              requestedConfiguration: {
                scenario: { id: scenario.id, version: scenario.version },
                parameters: variant.parameters ?? {},
                databaseStartup: variant.databaseStartup ?? {},
                databaseRunControls: structuredClone(variant.databaseRunControls),
                inputs: redactSecrets(request.inputs)
              },
              scheduleName,
              inputs: redactSecrets(request.inputs),
              inputProvenance,
              openedgeImageManifestPath: this.options.openedge?.imageManifestPath,
              variant,
              databaseStartup: variant.databaseStartup,
              databaseRunControls: structuredClone(variant.databaseRunControls),
              effectiveConfiguration: effective.values,
              parameterAdapterVersion: effective.adapterVersion,
              metricContracts: {
                resources: "resource-metrics.v2",
                summary: "measurement-summary.v1",
                nativeDb:
                  variant.databaseRunControls?.requirements?.observerProtocolVersion === 4
                    ? "openedge-db-observer.v4"
                    : "openedge-db-observer.v3"
              },
              sourceCadences: {
                prometheusScrapeSeconds: this.options.observerSamplingIntervalSeconds ?? 5,
                cadvisorHousekeepingSeconds: this.options.cadvisorHousekeepingSeconds ?? 1,
                nativeDatabaseRefreshSeconds: Math.max(
                  1,
                  Number(process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_REFRESH_MS ?? 5000) / 1000
                ),
                observers: scenario.observers.map((o) => ({
                  id: o.id,
                  kind: o.kind,
                  stepSeconds:
                    this.options.observerSamplingIntervalSeconds ?? o.samplingIntervalSeconds,
                  publisher: ["openedge_pas_v1", "openedge_db_v1"].includes(o.kind)
                    ? "endpoint"
                    : "controller"
                }))
              },
              deterministicLoadSeed: scenario.workload.load.seed ?? 1,
              createdAt: new Date().toISOString()
            },
            cleanupStatus: "PENDING"
          };
          this.repositories.saveRun(run);
          if (staticObserverFailure) {
            run.failureKind = staticObserverFailure.failureKind;
            run.failureCode = staticObserverFailure.failureCode;
            run.failureReason = staticObserverFailure.failureReason.slice(0, 512);
            machine.transition(run, "FAILED", run.failureReason, "controller", {
              failureKind: run.failureKind,
              failureCode: run.failureCode
            });
          }
          experiment.runIds.push(id);
        }
      if (staticObserverFailure)
        this.repositories.updateExperimentStatus(experiment.id, "FAILED", new Date().toISOString());
      this.repositories.client.db.exec("RELEASE SAVEPOINT parkbench_create_experiment");
    } catch (error) {
      this.repositories.client.db.exec("ROLLBACK TO SAVEPOINT parkbench_create_experiment");
      this.repositories.client.db.exec("RELEASE SAVEPOINT parkbench_create_experiment");
      throw error;
    }
    return experiment;
  }

  private validateOpenEdgeManifest(request: ExperimentRequest, scenario: Scenario): void {
    const manifestPath = this.options.openedge?.imageManifestPath;
    const hasWorkEndpoint = workProcedureNames(scenario).length > 0;
    if (!manifestPath) {
      if (hasWorkEndpoint) throw new Error("final_openedge_manifest_required");
      return;
    }
    if (!fs.existsSync(manifestPath)) throw new Error("openedge_image_manifest_missing");
    const manifest = validateBenchmarkImageManifest(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")),
      true
    );
    const configuredObserverImage = this.options.openedge?.observerImage;
    if (configuredObserverImage && manifest.observer.reference !== configuredObserverImage)
      throw new Error("observer_image_mismatch");
    if (manifest.db.reference !== request.inputs.databaseImage)
      throw new Error("openedge_manifest_database_image_mismatch");
    if (manifest.pasoe.reference !== request.inputs.pasImage)
      throw new Error("openedge_manifest_pasoe_image_mismatch");
    if (!hasWorkEndpoint) return;
    validateWorkScenario(scenario, manifest);
    if (
      !request.inputs.seed ||
      request.inputs.seed.startsWith("input:") ||
      !request.inputs.applicationArchive ||
      request.inputs.applicationArchive.startsWith("input:")
    )
      throw new Error("seed_path_required");
    const seed = checkReadableSeedDirectory(request.inputs.seed);
    if (this.options.runRoot) checkRunRootSpace(seed, this.options.runRoot);
    checkReadableFile(request.inputs.applicationArchive, "application_archive");
    // Each /work procedure's contract must name the selected seed's database before anything is
    // provisioned; its tables are checked by the workload's validate mode during readiness.
    const workloadsRoot = path.resolve(
      this.options.workloadsRoot ?? path.join(process.cwd(), "openedge/workloads/Workloads")
    );
    for (const procName of workProcedureNames(scenario)) {
      const workload = manifest.workloads!.find((candidate) => candidate.procName === procName)!;
      const contractFile = path.resolve(
        workloadsRoot,
        workload.contract!.path.replace(/^Workloads\//, "")
      );
      if (!contractFile.startsWith(`${workloadsRoot}${path.sep}`) || !fs.existsSync(contractFile))
        throw new Error(`workload_contract_missing:${procName}`);
      const contract = validateWorkloadContract(
        JSON.parse(fs.readFileSync(contractFile, "utf8")),
        procName
      );
      checkContractAgainstSeed(contract, seed);
    }
  }

  /** Contract files of the manifest's workloads, by procedure name. */
  private workloadContracts(): Map<string, ReturnType<typeof validateWorkloadContract>> {
    const contracts = new Map<string, ReturnType<typeof validateWorkloadContract>>();
    const manifestPath = this.options.openedge?.imageManifestPath;
    if (!manifestPath || !fs.existsSync(manifestPath)) return contracts;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const workloadsRoot = path.resolve(
      this.options.workloadsRoot ?? path.join(process.cwd(), "openedge/workloads/Workloads")
    );
    for (const workload of manifest.workloads ?? []) {
      if (!workload?.contract?.path) continue;
      const file = path.resolve(
        workloadsRoot,
        String(workload.contract.path).replace(/^Workloads\//, "")
      );
      if (!file.startsWith(`${workloadsRoot}${path.sep}`) || !fs.existsSync(file)) continue;
      contracts.set(
        workload.procName,
        validateWorkloadContract(JSON.parse(fs.readFileSync(file, "utf8")), workload.procName)
      );
    }
    return contracts;
  }

  /** `/work` procedures whose contract asks for schema validation before measurement. */
  private schemaReadinessProcedures(scenario: Scenario): string[] {
    const contracts = this.workloadContracts();
    return workProcedureNames(scenario).filter(
      (procName) => contracts.get(procName)?.readiness.mode === "validate"
    );
  }

  startExperiment(experimentId: string): void {
    if (this.activeExperiment && this.activeExperiment !== experimentId)
      throw new Error("one_active_experiment_limit");
    if (this.activeExperiment === experimentId) return;
    const experiment = this.repositories.getExperiment(experimentId);
    if (!experiment) throw new Error("experiment_not_found");
    if (experiment.status === "FAILED") throw new Error("experiment_preflight_failed");
    this.repositories.updateExperimentStatus(
      experimentId,
      "RUNNING",
      undefined,
      new Date().toISOString()
    );
    this.activeExperiment = experimentId;
    // Persistence failures must not become an unhandled detached rejection.
    void this.executeExperiment(experiment).catch((error) => {
      console.error(
        "experiment_execution_failed",
        redactSecrets(String(error), runtimeSecretValues())
      );
    });
  }

  private async executeExperiment(experiment: Experiment): Promise<void> {
    try {
      for (const runId of experiment.runIds) {
        const run = this.repositories.getRun(runId);
        if (!run) continue;
        if (isTerminal(run.state)) continue;
        const completed = await this.executeRun(run, this.behavior.get(run.id) ?? {});
        if (shouldStopMatrix(completed.state)) break;
      }
      const runs = this.repositories.listRuns(experiment.id);
      const status = aggregateExperimentStatus(
        runs.map((run) => run.state),
        experiment.comparisonMode === "exploratory"
      );
      this.repositories.updateExperimentStatus(experiment.id, status, new Date().toISOString());
    } finally {
      this.activeExperiment = undefined;
      // Wake dispatch only after the next experiment can acquire the serial slot.
      for (const listener of this.experimentFinishedListeners) listener();
    }
  }

  async executeRun(run: Run, behavior: RunBehavior = {}): Promise<Run> {
    try {
      return await this.executeRunInternal(run, behavior);
    } catch (error) {
      // Includes preparation before a bundle exists and unexpected finalization failures.
      const inputs = ((run.environmentSnapshot as any)?.inputs ?? {}) as Record<string, unknown>;
      const secrets = [...runtimeSecretValues(), ...privateInputValues(Object.values(inputs))];
      const classified = classifyRunError(error);
      run.failureKind = classified?.failureKind ?? run.failureKind ?? "infrastructure";
      run.failureCode = classified?.failureCode ?? run.failureCode;
      run.failureReason = String(
        redactSecrets(classified?.failureReason ?? String(error), secrets)
      ).slice(0, 512);
      const bundle = this.activeRuns.get(run.id);
      const resources = this.repositories.listResources(run.id);
      if (isTerminal(run.state)) {
        this.repositories.saveRun(run);
        return run;
      }
      if (bundle) {
        try {
          return await this.finalize(
            run,
            bundle,
            resources as unknown as Awaited<ReturnType<RunOrchestrator["provision"]>>,
            "FAILED"
          );
        } catch {
          run.cleanupStatus = "FAILED";
        }
      } else {
        run.cleanupStatus = resources.some(
          (resource) => !resource.deletedAt || resource.cleanupResult !== "deleted"
        )
          ? "PARTIAL"
          : "COMPLETE";
      }
      run.startedAt ??= new Date().toISOString();
      return new RunStateMachine(this.repositories).transition(
        run,
        "FAILED",
        run.failureReason,
        "controller",
        {
          failureKind: run.failureKind,
          failureCode: run.failureCode,
          cleanupStatus: run.cleanupStatus
        }
      );
    }
  }

  private async executeRunInternal(run: Run, behavior: RunBehavior): Promise<Run> {
    const machine = new RunStateMachine(this.repositories);
    const scenario = (run.environmentSnapshot as any)?.scenario as Scenario;
    const inputs = ((run.environmentSnapshot as any)?.inputs ?? {}) as Record<string, any>;
    if (
      typeof inputs.applicationArchive === "string" &&
      !inputs.applicationArchive.startsWith("input:")
    )
      assertScenarioArchiveCompatible(inputs.applicationArchive, scenario);
    const bundle = generateRunCompose(
      run.id,
      run.experimentId,
      scenario,
      { db: inputs.databaseImage, pas: inputs.pasImage },
      {
        seed: inputs.seed,
        databaseName: inputs.databaseName,
        schemaReadinessProcedures: this.schemaReadinessProcedures(scenario),
        applicationArchive: inputs.applicationArchive,
        credentialRef: inputs.credentialRef,
        variantId: run.variantId,
        repetition: run.repetition,
        phaseScale: this.options.phaseScale,
        parameters: ((run.environmentSnapshot as any)?.effectiveConfiguration ?? {}) as Record<
          string,
          string | number | boolean
        >,
        databaseStartup: (run.environmentSnapshot as any)?.databaseStartup,
        databaseRunControls: (run.environmentSnapshot as any)?.databaseRunControls,
        dbObserverProcedure: this.options.openedge?.dbObserverProcedure,
        dbObserverExecutable: this.options.openedge?.dbObserverExecutable,
        dbObserverArgs: this.options.openedge?.dbObserverArgs,
        dbObserverRuntimePath: this.options.openedge?.dbObserverRuntimePath,
        loadgenImage: this.options.supportImages?.loadgen,
        observerImage: this.options.supportImages?.observer,
        dbObserverImage: this.options.openedge?.observerImage,
        runtimeDirectory: path.join(this.artifacts.storage.root, run.id, "runtime"),
        summaryPath: path.join(this.artifacts.storage.root, run.id, "runtime", "summary.json"),
        shutdownPath: path.join(this.artifacts.storage.root, run.id, "runtime", "shutdown"),
        workloadStartPath: path.join(
          this.artifacts.storage.root,
          run.id,
          "runtime",
          "workload-start"
        ),
        phaseClockPath: path.join(
          this.artifacts.storage.root,
          run.id,
          "runtime",
          "phase-clock.json"
        )
      }
    );
    this.activeRuns.set(run.id, bundle);
    let resources: Awaited<ReturnType<RunOrchestrator["provision"]>> = [];
    run.startedAt = new Date().toISOString();
    this.repositories.saveRun(run);
    try {
      this.writeRunArtifacts(run, scenario, bundle);
    } catch (error) {
      run.failureKind = "export";
      run.failureReason = String(error);
      return this.finalize(run, bundle, resources, "FAILED");
    }
    machine.transition(run, "PROVISIONING", "run resources requested");

    if (this.cancellationRequests.has(run.id)) {
      return this.finalizeCancelled(run, bundle, resources);
    }

    try {
      resources = await this.options.orchestrator.provision(bundle, () =>
        this.cancellationRequests.has(run.id)
      );
      resources.forEach((resource) => this.repositories.saveResource(run.id, resource));
      if (this.cancellationRequests.has(run.id)) {
        return this.finalizeCancelled(run, bundle, resources);
      }
      const targetLabels = (component: string, service: string) => {
        const { phase, ...labels } = buildRunLabels({
          experiment_id: run.experimentId,
          run_id: run.id,
          variant_id: run.variantId,
          repetition: String(run.repetition),
          component,
          service,
          phase: "idle"
        });
        return labels;
      };
      const discoveryTargets = [
        { targets: ["node-exporter:9100"], labels: targetLabels("host", "node-exporter") },
        {
          targets: ["cadvisor:8080"],
          labels: {
            ...targetLabels("platform", "cadvisor"),
            project: "parkbench-platform"
          }
        },
        {
          targets: [this.options.runCAdvisorTarget?.() ?? "control-plane:3000"],
          labels: targetLabels("run", "run-cadvisor")
        },
        ...bundle.resources
          .filter((resource) =>
            ["loadgen", "db-observer", "pas-observer", "file-sampler"].includes(resource.name)
          )
          .map((resource) => ({
            targets: [`${bundle.projectName}-${resource.name}:9100`],
            labels: targetLabels(
              resource.name === "loadgen"
                ? "loadgen"
                : resource.name === "db-observer"
                  ? "database"
                  : resource.name === "pas-observer"
                    ? "pas"
                    : "observer",
              resource.name === "db-observer"
                ? "database"
                : resource.name === "pas-observer"
                  ? "pas"
                  : resource.name
            )
          }))
      ];
      this.options.targetDiscovery?.add(run.id, discoveryTargets);
      const targetResource = this.options.targetDiscovery
        ? {
            resourceType: "target_file" as const,
            resourceId: this.options.targetDiscovery.filePath,
            labels: ownershipLabels(run.id, run.experimentId, "target-file"),
            createdAt: new Date().toISOString()
          }
        : undefined;
      if (targetResource) {
        resources.push(targetResource);
        this.repositories.saveResource(run.id, targetResource);
      }
      const metadata = await this.options.orchestrator.metadata();
      const [databaseImage, pasImage, loadgenImage, observerImage] = await Promise.all([
        this.options.orchestrator.inspectImageDetails?.(inputs.databaseImage),
        this.options.orchestrator.inspectImageDetails?.(inputs.pasImage),
        this.options.supportImages?.loadgen
          ? this.options.orchestrator.inspectImageDetails?.(this.options.supportImages.loadgen)
          : Promise.resolve(undefined),
        this.options.supportImages?.observer
          ? this.options.orchestrator.inspectImageDetails?.(this.options.supportImages.observer)
          : Promise.resolve(undefined)
      ]);
      const configuredImages = {
        database: inputs.databaseImage,
        pas: inputs.pasImage,
        loadgen: this.options.supportImages?.loadgen,
        observer: this.options.supportImages?.observer
      };
      const inspectedImages = {
        database: databaseImage,
        pas: pasImage,
        loadgen: loadgenImage,
        observer: observerImage
      };
      const imageSnapshots = Object.fromEntries(
        Object.entries(configuredImages).map(([key, configured]) => [
          key,
          imageIdentitySnapshot(
            String(configured ?? ""),
            inspectedImages[key as keyof typeof inspectedImages]
          )
        ])
      );
      run.imageSnapshots = imageSnapshots;
      run.environmentSnapshot = {
        ...(run.environmentSnapshot ?? {}),
        hostDocker: metadata,
        resolvedImages: {
          database: imageSnapshots.database,
          pas: imageSnapshots.pas,
          loadgen: imageSnapshots.loadgen,
          observer: imageSnapshots.observer
        },
        observerHostPorts: bundle.observerPorts ?? {}
      };
      this.repositories.saveRun(run);
      if (behavior.readinessFailure) throw new Error("run_readiness_timeout");
      const readinessTimeoutMs = Number.parseInt(
        process.env.PARKBENCH_OPENEDGE_READINESS_TIMEOUT_MS ?? "300000",
        10
      );
      if (!Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 1000)
        throw new Error("openedge_readiness_timeout_invalid");
      await this.options.orchestrator.waitForReady(bundle, scenario, readinessTimeoutMs, () =>
        this.cancellationRequests.has(run.id)
      );
      if (this.cancellationRequests.has(run.id))
        return this.finalizeCancelled(run, bundle, resources);
      if (bundle.databaseRunControls) {
        if (!bundle.databaseRunControlEvidence)
          throw new DatabaseRunControlsError("database_run_control_unapplied");
        run.environmentSnapshot = {
          ...run.environmentSnapshot,
          databaseRunControlEvidence: structuredClone(bundle.databaseRunControlEvidence)
        };
        this.repositories.saveRun(run);
      }
      machine.transition(run, "DB_READY", "database readiness probe passed");
      machine.transition(run, "PAS_READY", "PAS readiness probe passed");
      await this.captureStartupParameters(run, bundle);
      await this.applyDatabaseLatency(run, bundle, scenario);
      if (this.cancellationRequests.has(run.id))
        return this.finalizeCancelled(run, bundle, resources);
      const context = {
        runId: run.id,
        experimentId: run.experimentId,
        variantId: run.variantId,
        repetition: run.repetition,
        phase: "warmup"
      } as const;
      const sink =
        this.options.observerMetrics ??
        (isMetricSink(this.prometheus) ? this.prometheus : undefined);
      const phaseClockStart = Date.now();
      // The clock file is created after target readiness, so the loadgen and
      // coordinator use the same boundary instead of measuring from startup.
      const clockPath = path.join(
        this.artifacts.storage.root,
        run.id,
        "runtime",
        "phase-clock.json"
      );
      fs.mkdirSync(path.dirname(clockPath), { recursive: true });
      fs.writeFileSync(
        clockPath,
        JSON.stringify({ startedAt: new Date(phaseClockStart).toISOString(), phase: "pending" })
      );
      await this.options.orchestrator.startWorkload(bundle);
      if (this.cancellationRequests.has(run.id))
        return this.finalizeCancelled(run, bundle, resources);
      const dbMetricsEnabled =
        (run.environmentSnapshot as any)?.effectiveConfiguration?.["database.metricsEnabled"] !==
        false;
      const observerDeclarations = scenario.observers
        .filter((declaration) => declaration.kind !== "openedge_db_v1" || dbMetricsEnabled)
        .map((declaration) => ({
          ...declaration,
          ...(this.options.observerSamplingIntervalSeconds
            ? { samplingIntervalSeconds: this.options.observerSamplingIntervalSeconds }
            : {}),
          configuration: {
            ...(declaration.configuration ?? {}),
            ...(["openedge_pas_v1", "openedge_db_v1"].includes(declaration.kind)
              ? { authoritativePublisher: "endpoint" }
              : {}),
            ...(declaration.kind === "openedge_pas_v1"
              ? { replicas: scenario.target.pasReplicas, credentialRef: inputs.credentialRef }
              : {}),
            ...(declaration.kind === "openedge_db_v1" &&
            typeof declaration.configuration?.metricsUrl !== "string"
              ? { metricsUrl: qualifyRunServiceUrl("http://db-observer:9100", bundle) }
              : {}),
            ...(declaration.kind === "openedge_db_v1"
              ? {
                  observerExecutable: undefined,
                  observerProcedure: undefined,
                  observerArgs: undefined
                }
              : {}),
            ...(typeof declaration.configuration?.metricsUrl === "string"
              ? { metricsUrl: qualifyRunServiceUrl(declaration.configuration.metricsUrl, bundle) }
              : {})
          }
        }));
      const collector = new ObserverCollector(
        observerDeclarations,
        context,
        this.options.observerFactory,
        sink
      );
      await collector.ready(context, readinessTimeoutMs, () =>
        this.cancellationRequests.has(run.id)
      );
      if (this.cancellationRequests.has(run.id))
        return this.finalizeCancelled(run, bundle, resources);
      if ((run.environmentSnapshot as any)?.databaseRunControls?.requirements?.namedLatchRequired) {
        try {
          const inventory = await collector.latchInventory(context);
          run.environmentSnapshot = {
            ...run.environmentSnapshot,
            namedLatchInventories: [structuredClone(inventory)]
          };
          this.repositories.saveRun(run);
        } catch (error) {
          throw new Error(`named_latch_evidence_missing:${String(error)}`);
        }
      }
      // Target readiness is a one-time startup gate. Target labels remain stable
      // throughout the run, so phase changes cannot restart Prometheus scrapes.
      if (this.prometheus.waitForRunTargets)
        await this.prometheus.waitForRunTargets(
          run.id,
          "",
          ["node-exporter", "cadvisor"],
          Math.max(10_000, (this.options.observerSamplingIntervalSeconds ?? 5) * 3_000 + 5_000)
        );
      if (this.cancellationRequests.has(run.id))
        return this.finalizeCancelled(run, bundle, resources);
      const schedule = phaseSchedule(scenario.phases, Date.now(), this.options.phaseScale);
      run.environmentSnapshot = {
        ...run.environmentSnapshot,
        metricsCollectionMode: "continuous",
        phaseSchedule: schedule
      };
      const counts: any[] = [];
      for (const timing of schedule) {
        const { phase, seconds, startMs, endMs } = timing;
        if (this.cancellationRequests.has(run.id)) break;
        await waitUntil(startMs);
        if (this.cancellationRequests.has(run.id)) break;
        const startedAt = new Date(startMs).toISOString();
        if (phase === "warmup") machine.transition(run, "WARMING_UP", "warmup started");
        if (phase === "measurement") machine.transition(run, "MEASURING", "measurement started");
        if (phase === "cooldown") machine.transition(run, "COOLDOWN", "measurement ended");
        run.phaseBoundaries = { ...(run.phaseBoundaries ?? {}), [phase]: { startedAt } };
        if (phase === "measurement") run.measuringAt = startedAt;
        this.repositories.saveRun(run);
        fs.writeFileSync(
          clockPath,
          JSON.stringify({
            startedAt: new Date(schedule[0].startMs).toISOString(),
            phase,
            continuous: true
          })
        );
        if (phase === "warmup" && bundle.workloadStartPath)
          fs.writeFileSync(bundle.workloadStartPath, startedAt);
        counts.push(
          ...(await collector.collectPhase(
            { ...context, phase },
            seconds,
            this.options.phaseScale,
            behavior.missingRequiredObserver
              ? new Set(scenario.observers.filter((item) => item.required).map((item) => item.id))
              : new Set(),
            () => this.cancellationRequests.has(run.id),
            // Zero-time fixture runs still exercise observers once per phase.
            // Real runs and scaled schedules retain exact shared deadlines.
            this.options.testMode && this.options.phaseScale === 0 ? undefined : timing,
            async () => {
              if (this.cancellationRequests.has(run.id)) return;
              const evidence = await this.options.orchestrator.checkDatabaseRunControls?.(bundle);
              if (evidence)
                run.environmentSnapshot = {
                  ...run.environmentSnapshot,
                  databaseRunControlEvidence: structuredClone(evidence)
                };
            }
          ))
        );
        const boundary = run.phaseBoundaries[phase]!;
        boundary.finishedAt = new Date(
          this.cancellationRequests.has(run.id) ? Math.min(endMs, Date.now()) : endMs
        ).toISOString();
        if (phase === "measurement")
          run.environmentSnapshot = {
            ...run.environmentSnapshot,
            measurementWindow: {
              start: boundary.startedAt,
              end: boundary.finishedAt,
              state: this.cancellationRequests.has(run.id) ? "interrupted" : "completed"
            }
          };
        this.repositories.saveRun(run);
      }
      if (this.cancellationRequests.has(run.id)) {
        return this.finalizeCancelled(run, bundle, resources);
      }
      if (this.options.orchestrator.waitForWorkload) {
        const exitCode = await this.options.orchestrator.waitForWorkload(
          bundle,
          () => this.cancellationRequests.has(run.id),
          (scenario.target.timeoutMs ?? OPENEDGE_WORKLOAD_TIMEOUT_MS) + 15_000
        );
        if (this.cancellationRequests.has(run.id))
          return this.finalizeCancelled(run, bundle, resources);
        const classified = classifyLoadgenExitCode(exitCode);
        run.environmentSnapshot = {
          ...(run.environmentSnapshot ?? {}),
          loadgenExitCode: exitCode
        };
        this.repositories.saveRun(run);
        if (classified.state) behavior = { ...behavior, terminalState: classified.state };
        if (classified.failureKind) run.failureKind = classified.failureKind;
        if (classified.reason) run.failureReason = classified.reason;
      }
      if (this.options.requiredDiskIo) {
        counts.push(
          ...(await this.collectDiskIoCompleteness(run, scenario.phases.measurementSeconds, bundle))
        );
      }
      const requiredMeasurementGaps = await this.collectRequiredMeasurementGaps(run, scenario);
      run.completeness = calculateCompleteness(
        counts
          .filter((count) => count.phase === "measurement")
          .map((count) => ({
            observerId: count.observerId,
            phase: count.phase,
            expected: count.expected,
            observed: count.observed,
            required: count.required,
            longestGapSeconds: count.longestGapSeconds,
            lastSuccessAt: count.lastSuccessAt,
            coverage: count.coverage
          }))
      );
      run.completeness.requiredGaps.push(...requiredMeasurementGaps);
      run.completeness.complete = run.completeness.requiredGaps.length === 0;
      if (!run.completeness.complete) {
        run.measurementValidity = "INCOMPLETE";
        run.failureKind = "observer";
        run.failureReason = run.completeness.requiredGaps
          .map((gap) =>
            gap.measurementId
              ? `required_measurement:${gap.measurementId}:${gap.phase}`
              : `${gap.observerId}:${gap.phase}`
          )
          .join(",");
      }
      run.observerHealth = {
        observers: Object.fromEntries(
          collector.runtimes.map((runtime) => [
            runtime.declaration.id,
            { diagnostics: observerDiagnosticsForRun(counts, runtime.declaration.id) }
          ])
        ),
        diskIo: counts
          .filter((count) => String(count.observerId).startsWith("disk-io-"))
          .map((count) => ({ observerId: count.observerId, diagnostics: count.diagnostics }))
      };
      run.environmentSnapshot = {
        ...run.environmentSnapshot,
        observerCollection: { counts, health: run.observerHealth, completeness: run.completeness }
      };
      this.repositories.saveRun(run);
      machine.transition(run, "FINALIZING", "finalization started");
    } catch (error) {
      if (error instanceof DatabaseRunControlsError && error.evidence)
        run.environmentSnapshot = {
          ...run.environmentSnapshot,
          databaseRunControlEvidence: structuredClone(error.evidence)
        };
      if (this.cancellationRequests.has(run.id))
        return this.finalizeCancelled(run, bundle, resources);
      const classifiedError = classifyRunError(error);
      if (classifiedError) {
        run.failureKind = classifiedError.failureKind;
        run.failureCode = classifiedError.failureCode;
        run.failureReason = classifiedError.failureReason.slice(0, 512);
      } else {
        run.failureKind = run.failureKind ?? "infrastructure";
        run.failureReason = (run.failureReason ?? String(error)).slice(0, 512);
      }
      saveDiagnostics(
        this.artifacts.storage,
        this.repositories,
        run.id,
        {
          code: "run_execution_failed",
          error: String(error),
          phase: run.phase,
          affectedService: readinessServiceFromError(error)
        },
        privateInputValues(Object.values(inputs))
      );
      return this.finalize(run, bundle, resources, "FAILED");
    }

    const complete = run.completeness?.complete === true;
    const requestedState = behavior.terminalState;
    const terminalState = this.cancellationRequests.has(run.id)
      ? "CANCELLED"
      : !complete && (!requestedState || ["SUCCEEDED", "THRESHOLD_FAILED"].includes(requestedState))
        ? "INCOMPLETE"
        : (requestedState ?? "SUCCEEDED");
    if (terminalState === "FAILED") {
      run.failureKind ??= "infrastructure";
      run.failureReason ??= "simulated infrastructure failure";
    }
    if (terminalState === "THRESHOLD_FAILED") {
      run.failureKind ??= "threshold";
      run.failureReason ??= "simulated threshold breach";
    }
    const originalQuery = this.prometheus.queryRange.bind(this.prometheus);
    const originalRaw = this.prometheus.queryRawRange.bind(this.prometheus);
    if (behavior.exportFailure) {
      this.prometheus.queryRawRange = async () => {
        throw new Error("simulated_prometheus_export_failure");
      };
      this.prometheus.queryRange = async () => {
        throw new Error("simulated_prometheus_export_failure");
      };
    }
    try {
      return await this.finalize(run, bundle, resources, terminalState);
    } finally {
      this.prometheus.queryRange = originalQuery;
      this.prometheus.queryRawRange = originalRaw;
      this.cancellationRequests.delete(run.id);
    }
  }

  cancel(runId: string): Run {
    const run = this.repositories.getRun(runId);
    if (!run) throw new Error("run_not_found");
    if (
      [
        "SUCCEEDED",
        "INCOMPLETE",
        "THRESHOLD_FAILED",
        "FAILED",
        "CANCELLED",
        "INTERRUPTED"
      ].includes(run.state)
    )
      throw new Error("run_already_terminal");
    if (run.state === "QUEUED") {
      run.failureKind = "cancellation";
      run.failureReason = "operator requested cancellation";
      run.measurementValidity = "UNAVAILABLE";
      run.cleanupStatus = "COMPLETE";
      return new RunStateMachine(this.repositories).transition(
        run,
        "CANCELLED",
        run.failureReason,
        "operator",
        { cancellationRequestedAt: new Date().toISOString() }
      );
    }
    this.cancellationRequests.add(runId);
    run.failureKind = "cancellation";
    run.failureReason = "operator requested cancellation";
    this.repositories.saveRun(run);
    this.repositories.saveEvent({
      runId: run.id,
      fromState: run.state,
      toState: run.state,
      occurredAt: new Date().toISOString(),
      actor: "operator",
      reason: "operator requested cancellation",
      details: { cancellationRequestedAt: new Date().toISOString() }
    });
    const bundle = this.activeRuns.get(runId);
    if (bundle?.shutdownPath) signalCancellation(bundle.shutdownPath);
    return run;
  }

  /**
   * Database Latency (feature 016): after readiness and before the load generator starts, delay
   * PAS<->database traffic by the run's one-way latency and record db-latency.v1 evidence. A
   * failure fails the run before warmup; it never runs silently without latency.
   */
  private async applyDatabaseLatency(
    run: Run,
    bundle: ComposeBundle,
    scenario: Scenario
  ): Promise<void> {
    const delayMs = databaseLatencyOf((run.environmentSnapshot as any)?.effectiveConfiguration);
    const record = (evidence: DatabaseLatencyEvidence) => {
      run.environmentSnapshot = { ...(run.environmentSnapshot ?? {}), databaseLatency: evidence };
      if (evidence.status !== "not_requested")
        this.artifacts.write(
          run.id,
          "database_latency",
          "database-latency.json",
          JSON.stringify(evidence, null, 2),
          "json",
          { contractVersion: evidence.contractVersion, status: evidence.status }
        );
      this.repositories.saveRun(run);
    };
    if (delayMs === 0) {
      record(notRequestedLatencyEvidence());
      return;
    }
    const startedAt = Date.now();
    try {
      if (!this.options.orchestrator.applyDatabaseLatency)
        throw new DatabaseLatencyError(DATABASE_LATENCY_UNSUPPORTED, { targets: [] });
      const evidence = await this.options.orchestrator.applyDatabaseLatency(
        bundle,
        {
          delayMs,
          pasServices: Array.from(
            { length: scenario.target.pasReplicas },
            (_, index) => `pas-${index + 1}`
          ),
          databaseService: "database",
          probePort: Number(process.env.PARKBENCH_OPENEDGE_DB_BROKER_PORT ?? 20931)
        },
        () => this.cancellationRequests.has(run.id)
      );
      record(evidence);
    } catch (error) {
      if (String(error).includes("run_cancelled")) return;
      const failureCode =
        error instanceof DatabaseLatencyError
          ? error.code
          : `${DATABASE_LATENCY_APPLY_FAILED}:${String((error as Error)?.message ?? error)}`;
      record({
        targets: [],
        ...(error instanceof DatabaseLatencyError ? error.evidence : {}),
        contractVersion: DATABASE_LATENCY_CONTRACT_VERSION,
        requestedMs: delayMs,
        appliedMs: 0,
        mode: "netem",
        status: "failed",
        failureCode,
        applyDurationMs: Date.now() - startedAt,
        appliedAt: new Date().toISOString()
      });
      throw new Error(failureCode);
    }
  }

  private async captureStartupParameters(run: Run, bundle: ComposeBundle): Promise<void> {
    if (
      !this.options.requireParameterCapture &&
      !this.options.openedge?.imageManifestPath &&
      !this.options.parameterCapture
    ) {
      run.environmentSnapshot = {
        ...(run.environmentSnapshot ?? {}),
        parameterSnapshotCapture: { state: "not_captured", reasonCode: "observer_unavailable" }
      };
      this.repositories.saveRun(run);
      return;
    }
    let capture: OpenEdgeDbParameterCapture;
    const captureStartedAt = Date.now();
    try {
      if (this.options.parameterCapture) capture = await this.options.parameterCapture(run, bundle);
      else {
        const url = qualifyRunServiceUrl("http://db-observer:9100/parameter-capture", bundle);
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`observer_capture_http:${response.status}`);
        capture = (await response.json()) as OpenEdgeDbParameterCapture;
      }
    } catch (error) {
      run.environmentSnapshot = {
        ...(run.environmentSnapshot ?? {}),
        parameterSnapshotCapture: { state: "not_captured", reasonCode: "observer_unavailable" }
      };
      this.repositories.saveRun(run);
      throw new Error(`database_parameter_capture_invalid:${String(error)}`);
    }
    try {
      validateOpenEdgeDbParameterCapture(capture);
    } catch (error) {
      run.environmentSnapshot = {
        ...(run.environmentSnapshot ?? {}),
        parameterSnapshotCapture: { state: "not_captured", reasonCode: "observer_response_invalid" }
      };
      this.repositories.saveRun(run);
      throw new Error(`database_parameter_capture_invalid:${String(error)}`);
    }
    const startup = (run.environmentSnapshot as any)?.databaseStartup;
    const snapshot = deriveDatabaseParameterSnapshot(
      capture,
      {
        runId: run.id,
        experimentId: run.experimentId,
        variantId: run.variantId,
        repetition: run.repetition
      },
      startup
    );
    const captureDurationSeconds = (Date.now() - captureStartedAt) / 1000;
    const seriesCount = parameterSnapshotSamples(snapshot, {
      runId: run.id,
      experimentId: run.experimentId,
      variantId: run.variantId,
      repetition: run.repetition,
      phase: "idle"
    }).length;
    this.artifacts.write(
      run.id,
      "db_parameter_snapshot",
      "db-parameter-snapshot.json",
      JSON.stringify(snapshot, null, 2),
      "json",
      { contractVersion: snapshot.contractVersion, captureDurationSeconds, seriesCount }
    );
    run.environmentSnapshot = {
      ...(run.environmentSnapshot ?? {}),
      parameterSnapshotCapture: { state: "captured", artifact: "db-parameter-snapshot.json" },
      parameterSnapshotTelemetry: { captureDurationSeconds, seriesCount },
      databaseStartup: startup
        ? {
            ...startup,
            parameters: startup.parameters.map((parameter: any) => {
              const result = snapshot.verificationResults.find(
                (item) => item.name === parameter.name
              );
              return result
                ? {
                    ...parameter,
                    verification: result.verification,
                    observedValue: result.observedValue,
                    reason: result.reason
                  }
                : parameter;
            })
          }
        : undefined
    };
    this.repositories.saveRun(run);
    const samples = parameterSnapshotSamples(snapshot, {
      runId: run.id,
      experimentId: run.experimentId,
      variantId: run.variantId,
      repetition: run.repetition,
      phase: "idle"
    });
    const sink =
      this.options.observerMetrics ?? (isMetricSink(this.prometheus) ? this.prometheus : undefined);
    sink?.append(samples);
    if (isMetricSink(this.prometheus) && sink !== this.prometheus) this.prometheus.append(samples);
    const failure = snapshot.verificationResults.find(
      (result) =>
        result.verification === "mismatched" ||
        (result.verification === "unverifiable" &&
          (!startup?.registryVersion ||
            databaseParameterDefinition(result.name)?.observability.kind === "broker_field"))
    );
    const verificationError = failure
      ? new Error(
          `${
            failure.verification === "mismatched"
              ? "database_parameter_unapplied"
              : "database_parameter_unverifiable"
          }:${failure.name}:requested=${failure.displayValue}:` +
            `observed=${failure.observedValue ?? "unknown"}:source=${failure.source}`
        )
      : undefined;
    try {
      const eligibleRows = samples.filter(
        (sample) => sample.metricName === "parkbench_openedge_db_parameter_snapshot_info"
      );
      const observationTime = samples.find(
        (sample) =>
          sample.metricName === "parkbench_openedge_db_parameter_snapshot_timestamp_seconds"
      );
      const deadline = Date.now() + 12_000;
      let ingested = false;
      let lastQueryError: unknown;
      do {
        try {
          const status = await this.prometheus.queryInstant(
            `parkbench_openedge_db_parameter_snapshot_status{run_id="${run.id}",database_name="${snapshot.databaseName}"}`
          );
          const info = await this.prometheus.queryInstant(
            `parkbench_openedge_db_parameter_snapshot_info{run_id="${run.id}",database_name="${snapshot.databaseName}"}`
          );
          const observedTime = observationTime
            ? await this.prometheus.queryInstant(
                `parkbench_openedge_db_parameter_snapshot_timestamp_seconds{run_id="${run.id}",database_name="${snapshot.databaseName}"}`
              )
            : [];
          ingested =
            status.some((item) => item.labels.state === snapshot.status && item.value === 1) &&
            eligibleRows.every((expected) =>
              info.some(
                (actual) =>
                  actual.value === expected.value &&
                  actual.labels.parameter === expected.labels.parameter &&
                  actual.labels.display_value === expected.labels.display_value &&
                  actual.labels.value_status === expected.labels.value_status
              )
            ) &&
            (!observationTime || observedTime.some((item) => item.value === observationTime.value));
        } catch (error) {
          lastQueryError = error;
        }
        if (ingested) break;
        if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      if (!ingested)
        throw new Error(
          `snapshot_prometheus_ingestion_timeout:${String(lastQueryError ?? "missing_series")}`
        );
    } catch (error) {
      saveDiagnostics(this.artifacts.storage, this.repositories, run.id, {
        code: "database_parameter_metrics_unavailable",
        error: String(error)
      });
      if (verificationError) throw verificationError;
      throw new Error(`database_parameter_metrics_unavailable:${String(error)}`);
    }
    if (verificationError) throw verificationError;
  }

  private async finalize(
    run: Run,
    bundle: ComposeBundle,
    resources: Awaited<ReturnType<RunOrchestrator["provision"]>>,
    terminalState: Run["state"]
  ): Promise<Run> {
    const measurement = run.phaseBoundaries?.measurement;
    const now = Date.now() / 1000;
    const measurementStart = measurement?.startedAt ?? run.measuringAt;
    const measurementEnd = measurement?.finishedAt;
    if (measurementStart && !measurementEnd) {
      run.phaseBoundaries = {
        ...run.phaseBoundaries,
        measurement: { startedAt: measurementStart, finishedAt: new Date(now * 1000).toISOString() }
      };
      this.repositories.saveRun(run);
    }
    const start = run.startedAt ? Date.parse(run.startedAt) / 1000 : now - 60;
    const end = now + 1;
    try {
      return await this.finalizer.finalize(run, {
        terminalState,
        start,
        end,
        measurementState: !measurementStart
          ? "not_started"
          : measurementEnd
            ? "completed"
            : "interrupted",
        measurementStart: measurementStart ? Date.parse(measurementStart) / 1000 : null,
        measurementEnd: measurementStart
          ? measurementEnd
            ? Date.parse(measurementEnd) / 1000
            : now
          : null,
        beforeMetrics: async () => {
          try {
            await this.options.orchestrator.stopWorkload(bundle);
          } catch (error) {
            saveDiagnostics(this.artifacts.storage, this.repositories, run.id, {
              code: "workload_stop_failed",
              error: String(error)
            });
          }
          this.registerLoadgenSummary(run, bundle);
        },
        cleanup: async () => {
          try {
            this.options.targetDiscovery?.remove(run.id);
          } catch (error) {
            const targetFile = resources.find(
              (resource) => resource.resourceType === "target_file"
            );
            if (targetFile)
              this.repositories.saveResource(run.id, {
                ...targetFile,
                deletedAt: undefined,
                cleanupResult: `target_file_cleanup_failed:${String(error)}`
              });
            throw error;
          }
          const cleaned = await this.options.orchestrator.cleanup(bundle, resources);
          cleaned.forEach((resource) => this.repositories.saveResource(run.id, resource));
          if (cleaned.some((resource) => resource.cleanupResult !== "deleted"))
            throw new Error("owned_resource_cleanup_incomplete");
        },
        collectLogs: this.options.orchestrator.collectLogs
          ? () => this.options.orchestrator.collectLogs!(bundle)
          : undefined
      });
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  private async finalizeCancelled(
    run: Run,
    bundle: ComposeBundle,
    resources: Awaited<ReturnType<RunOrchestrator["provision"]>>
  ): Promise<Run> {
    run.failureKind ??= "cancellation";
    run.failureReason ??= "operator requested cancellation";
    try {
      return await this.finalize(run, bundle, resources, "CANCELLED");
    } finally {
      this.cancellationRequests.delete(run.id);
    }
  }

  private async collectDiskIoCompleteness(
    run: Run,
    measurementSeconds: number,
    bundle: ComposeBundle
  ): Promise<any[]> {
    const durationSeconds = Math.max(1, measurementSeconds * Math.max(this.options.phaseScale, 0));
    const scrapeIntervalSeconds = Math.max(0.25, this.options.observerSamplingIntervalSeconds ?? 1);
    const expected = Math.max(1, Math.ceil(durationSeconds / scrapeIntervalSeconds));
    const phase = run.phaseBoundaries?.measurement;
    const phaseStart = phase?.startedAt ? Date.parse(phase.startedAt) / 1000 : Number.NaN;
    const phaseEnd = phase?.finishedAt ? Date.parse(phase.finishedAt) / 1000 : Number.NaN;
    const start = Number.isFinite(phaseStart)
      ? phaseStart
      : Date.now() / 1000 - durationSeconds - scrapeIntervalSeconds;
    const end = Number.isFinite(phaseEnd) ? phaseEnd : Date.now() / 1000 + scrapeIntervalSeconds;
    const definitions = [
      {
        observerId: "disk-io-cadvisor-read",
        query: DISK_IO_QUERIES.containerRead,
        type: "container" as const
      },
      {
        observerId: "disk-io-cadvisor-write",
        query: DISK_IO_QUERIES.containerWrite,
        type: "container" as const
      },
      {
        observerId: "disk-io-cadvisor-read-operations",
        query: DISK_IO_QUERIES.containerReadOperations,
        type: "container" as const
      },
      {
        observerId: "disk-io-cadvisor-write-operations",
        query: DISK_IO_QUERIES.containerWriteOperations,
        type: "container" as const
      },
      {
        observerId: "disk-io-node-exporter-read",
        query: DISK_IO_QUERIES.hostRead,
        type: "host" as const
      },
      {
        observerId: "disk-io-node-exporter-write",
        query: DISK_IO_QUERIES.hostWrite,
        type: "host" as const
      },
      {
        observerId: "disk-io-node-exporter-read-operations",
        query: DISK_IO_QUERIES.hostReadOperations,
        type: "host" as const
      },
      {
        observerId: "disk-io-node-exporter-write-operations",
        query: DISK_IO_QUERIES.hostWriteOperations,
        type: "host" as const
      },
      {
        observerId: "disk-io-node-exporter-io-time",
        query: DISK_IO_QUERIES.hostIoTime,
        type: "host" as const
      }
    ];
    const options = finalizationQueryOptions(run);
    const results: Array<{
      observerId: string;
      query: string;
      type: "container" | "host";
      counts: Map<string, { observed: number; last: number }>;
      coverages: Map<string, Coverage>;
      error?: string;
    }> = [];
    for (const definition of definitions) {
      const counts = new Map<string, { observed: number; last: number }>();
      const samples = new Map<string, MetricSample[]>();
      let sampleCount = 0;
      const selector =
        definition.type === "container"
          ? `{job="parkbench-run-owned-cadvisor",run_id=${JSON.stringify(run.id)}}`
          : `{run_id=${JSON.stringify(run.id)}${(run.environmentSnapshot as any)?.metricsCollectionMode === "continuous" ? "" : ',phase="measurement"'}}`;
      let error: string | undefined;
      try {
        for await (const chunk of readRawChunks(
          this.prometheus,
          definition.query + selector,
          start,
          end,
          scrapeIntervalSeconds,
          options
        )) {
          const ticks = new Map<string, Set<number>>();
          for (const sample of chunk.samples) {
            const key =
              definition.type === "container"
                ? diskIoService(sample.labels)
                : (sample.labels.device ?? sample.labels.disk ?? "host");
            const times = ticks.get(key) ?? new Set<number>();
            times.add(Math.floor(sample.timestamp));
            ticks.set(key, times);
            if (definition.type === "container") {
              const values = samples.get(key) ?? [];
              values.push(sample);
              samples.set(key, values);
              if (++sampleCount > 100000) throw new Error("summary_limit_exceeded:disk_samples");
            }
          }
          for (const [key, times] of ticks) {
            const count = counts.get(key) ?? { observed: 0, last: -Infinity };
            for (const time of [...times].sort((a, b) => a - b))
              if (time > count.last) {
                count.observed++;
                count.last = time;
              }
            counts.set(key, count);
          }
          recordVerificationQuery(run, {
            selector: chunk.query,
            start: chunk.start,
            end: chunk.end,
            purpose: "disk_io_verification",
            observed: chunk.samples.length > 0
          });
          if (counts.size > 100000) throw new Error("summary_limit_exceeded:disk_series");
        }
      } catch (failure) {
        error = String(failure);
        recordVerificationQuery(run, {
          selector: definition.query + selector,
          start,
          end,
          purpose: "disk_io_verification",
          reason: error.slice(0, 300),
          observed: false
        });
      }
      const coverages = new Map<string, Coverage>();
      if (definition.type === "container" && !error && end > start)
        for (const [key, values] of samples)
          coverages.set(
            key,
            measurementStatistics(
              metricSeries(values, scrapeIntervalSeconds).map((series) => ({
                ...series,
                acquisitionLagSeconds: this.options.cadvisorHousekeepingSeconds ?? 1
              })),
              { start, end },
              {
                type: "counter",
                unit: "activity_per_second",
                totalUnit: "activity",
                allowExactEnd: true
              }
            ).coverage
          );
      results.push({ ...definition, counts, coverages, error });
    }
    const configuredDevices = (process.env.PARKBENCH_REQUIRED_DISK_DEVICES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[a-zA-Z0-9_.-]+$/.test(s));
    const discovered = [
      ...new Set(results.filter((r) => r.type === "host").flatMap((r) => [...r.counts.keys()]))
    ];
    const devices = configuredDevices.length
      ? configuredDevices
      : discovered.length
        ? discovered
        : ["host"];
    return results.flatMap(({ observerId, query, type, counts, coverages, error }) => {
      const keys =
        type === "container"
          ? bundle.resources
              .filter(
                (r) => r.type === "container" && (r.name === "database" || /^pas-\d+$/.test(r.name))
              )
              .map((r) => r.name)
          : devices;
      return keys.map((key) => {
        const observed = error ? 0 : (counts.get(key)?.observed ?? 0);
        // Cardinality alone can reject a complete phase whose first/last scrape
        // carries cAdvisor's older housekeeping timestamp. Retain raw counts,
        // and require the same bounded in-phase counter coverage as the summary.
        const coverage = coverages.get(key);
        const complete = coverage
          ? observed > 0 && coverage.missingSeconds <= 1e-8
          : observed >= expected;
        return {
          observerId: `${observerId}:${key}`,
          phase: "measurement",
          expected,
          observed,
          required: true,
          ...(coverage ? { coverage } : {}),
          diagnostics:
            complete && !error
              ? []
              : [
                  {
                    code: error ? "disk_io_source_failed" : "disk_io_samples_missing",
                    query,
                    series: key,
                    expected,
                    observed,
                    error
                  }
                ]
        };
      });
    });
  }

  private registerLoadgenSummary(run: Run, bundle: ComposeBundle): void {
    if (!bundle.summaryPath || !fs.existsSync(bundle.summaryPath)) {
      saveDiagnostics(this.artifacts.storage, this.repositories, run.id, {
        code: "loadgen_summary_missing",
        sizeBytes: 0
      });
      return;
    }
    const contents = fs.readFileSync(bundle.summaryPath);
    if (!contents.byteLength) {
      saveDiagnostics(this.artifacts.storage, this.repositories, run.id, {
        code: "loadgen_summary_missing",
        sizeBytes: 0
      });
      return;
    }
    const validation = validateLoadgenSummary(contents, run.id);
    if (!validation.valid) {
      saveDiagnostics(this.artifacts.storage, this.repositories, run.id, {
        code: "loadgen_summary_invalid",
        errors: validation.errors,
        sizeBytes: contents.byteLength
      });
      return;
    }
    run.environmentSnapshot = {
      ...run.environmentSnapshot,
      loadgenSummary: JSON.parse(contents.toString("utf8"))
    };
    fs.writeFileSync(this.artifacts.storage.safePath(`${run.id}/loadgen-summary.json`), contents);
    this.repositories.saveRun(run);
  }

  private writeRunArtifacts(run: Run, scenario: Scenario, bundle: ComposeBundle): void {
    run.environmentSnapshot = {
      ...run.environmentSnapshot,
      contextCapturedAt: new Date().toISOString(),
      contextContractVersion: "run-context.v1"
    };
    persistRunContext(run, this.artifacts.storage, this.repositories);
    this.repositories.saveRun(run);
    this.artifacts.write(run.id, "compose_bundle", "run-compose.yml", bundle.file, "yaml");
    this.artifacts.write(run.id, "log", "run.log", "run started\n");
  }

  private async collectRequiredMeasurementGaps(
    run: Run,
    scenario: Scenario
  ): Promise<ReturnType<typeof calculateRequiredMeasurementGaps>> {
    const dbMetricsEnabled =
      (run.environmentSnapshot as any)?.effectiveConfiguration?.["database.metricsEnabled"] !==
      false;
    const requirements = (scenario.requiredMeasurements ?? []).filter(
      (requirement) =>
        dbMetricsEnabled || !requirement.metricName.startsWith("parkbench_openedge_db_")
    );
    if (!requirements.length) return [];
    const options = finalizationQueryOptions(run);
    const gaps: ReturnType<typeof calculateRequiredMeasurementGaps> = [];
    for (const requirement of requirements) {
      for (const phase of requirement.phases ?? ["measurement"]) {
        const boundary = run.phaseBoundaries?.[phase];
        const start = boundary?.startedAt ? Date.parse(boundary.startedAt) / 1000 : NaN;
        const end = boundary?.finishedAt ? Date.parse(boundary.finishedAt) / 1000 : NaN;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const phaseMatcher =
          run.environmentSnapshot?.metricsCollectionMode === "continuous"
            ? `phase=~${JSON.stringify(`${phase}|^$`)}`
            : `phase=${JSON.stringify(phase)}`;
        const labels = `run_id=${JSON.stringify(run.id)},experiment_id=${JSON.stringify(run.experimentId)},${phaseMatcher}`;
        const scoped = { ...requirement, phases: [phase] };
        let failure: string | undefined;
        let unavailableGap: ReturnType<typeof calculateRequiredMeasurementGaps>[number] | undefined;
        let found = false;
        try {
          for await (const chunk of readRawChunks(
            this.prometheus,
            `${requirement.metricName}{${labels}}`,
            start,
            end,
            this.options.observerSamplingIntervalSeconds ?? 5,
            options
          )) {
            recordVerificationQuery(run, {
              selector: chunk.query,
              start: chunk.start,
              end: chunk.end,
              purpose: "scenario_required_verification",
              observed: chunk.samples.length > 0
            });
            const candidates = chunk.samples.filter((s) => s.metricName === requirement.metricName);
            if (
              !requirement.metricName.startsWith("parkbench_openedge_db_") ||
              requirement.metricName === "parkbench_openedge_db_metric_available"
            ) {
              if (!candidates.length) continue;
              found = true;
              break;
            }
            const measurement = requirement.metricName.slice("parkbench_openedge_db_".length);
            for await (const availability of readRawChunks(
              this.prometheus,
              `parkbench_openedge_db_metric_available{${labels},measurement=${JSON.stringify(measurement)}}`,
              chunk.start,
              chunk.end,
              this.options.observerSamplingIntervalSeconds ?? 5,
              options
            )) {
              recordVerificationQuery(run, {
                selector: availability.query,
                start: availability.start,
                end: availability.end,
                purpose: "scenario_required_verification",
                observed: availability.samples.length > 0
              });
              const missing = calculateRequiredMeasurementGaps(
                [scoped],
                [...candidates, ...availability.samples]
              )[0];
              if (!missing) {
                found = true;
                break;
              }
              if (missing.availabilityReason) unavailableGap = missing;
            }
            if (found) break;
          }
        } catch (error) {
          failure = String(error).includes("summary_limit_exceeded")
            ? "summary_limit_exceeded"
            : String(error).includes("query_timeout") || String(error).includes("TimeoutError")
              ? "query_timeout"
              : "source_unavailable";
          recordVerificationQuery(run, {
            selector: `${requirement.metricName}{${labels}}`,
            start,
            end,
            purpose: "scenario_required_verification",
            observed: false,
            reason: failure
          });
        }
        if (!found) {
          const gap = unavailableGap ?? calculateRequiredMeasurementGaps([scoped], [])[0];
          if (gap)
            gaps.push({
              ...gap,
              availabilityReason: failure ?? gap.availabilityReason ?? "required_series_missing"
            });
        }
      }
    }
    return gaps;
  }
}

export function observerDiagnosticsForRun(
  counts: Array<{ observerId: string; diagnostics?: unknown[] }>,
  observerId: string
): unknown[] {
  return counts
    .filter((count) => count.observerId === observerId)
    .flatMap((count) => count.diagnostics ?? []);
}

function escapePrometheusLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function validateLoadgenSummary(
  contents: Buffer,
  expectedRunId: string
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!contents.byteLength) return { valid: false, errors: ["summary_empty"] };
  if (contents.byteLength > 4 * 1024 * 1024) errors.push("summary_too_large");
  let summary: any;
  try {
    summary = JSON.parse(contents.toString("utf8"));
  } catch {
    errors.push("summary_json_invalid");
    return { valid: false, errors };
  }
  if (!summary || typeof summary !== "object" || Array.isArray(summary))
    errors.push("summary_object_required");
  if (summary?.contractVersion !== "loadgen.v1") errors.push("contract_version_invalid");
  if (summary?.runId !== expectedRunId) errors.push("run_id_mismatch");
  for (const key of ["startedAt", "finishedAt", "shutdownReason"])
    if (typeof summary?.[key] !== "string" || !summary[key]) errors.push(`${key}_required`);
  if (!summary?.phaseDurationsSeconds || typeof summary.phaseDurationsSeconds !== "object")
    errors.push("phase_durations_required");
  else
    for (const [key, value] of Object.entries(summary.phaseDurationsSeconds))
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        errors.push(`phase_duration_invalid:${key}`);
  if (!summary?.requests || typeof summary.requests !== "object") errors.push("requests_required");
  else
    for (const key of ["completed", "errors"])
      if (
        typeof summary.requests[key] !== "number" ||
        !Number.isSafeInteger(summary.requests[key]) ||
        summary.requests[key] < 0
      )
        errors.push(`requests_${key}_invalid`);
  if (!summary?.operations || typeof summary.operations !== "object")
    errors.push("operations_required");
  else
    for (const [key, operation] of Object.entries(summary.operations)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || !operation || typeof operation !== "object") {
        errors.push(`operation_invalid:${key}`);
        continue;
      }
      for (const field of ["completed", "errors"])
        if (
          typeof (operation as any)[field] !== "number" ||
          !Number.isSafeInteger((operation as any)[field]) ||
          (operation as any)[field] < 0
        )
          errors.push(`operation_${field}_invalid:${key}`);
    }
  if (!summary?.latencySeconds || typeof summary.latencySeconds !== "object")
    errors.push("latency_required");
  else
    for (const key of ["count", "p50", "p95", "p99"])
      if (
        typeof summary.latencySeconds[key] !== "number" ||
        !Number.isFinite(summary.latencySeconds[key]) ||
        summary.latencySeconds[key] < 0 ||
        (key === "count" && !Number.isSafeInteger(summary.latencySeconds[key]))
      )
        errors.push(`latency_${key}_invalid`);
  if (summary?.timeoutCount !== undefined) {
    if (!Number.isSafeInteger(summary.timeoutCount) || summary.timeoutCount < 0)
      errors.push("timeout_count_invalid");
    if (summary.timeoutCount > 0) {
      if (summary.timeoutMs !== 60000) errors.push("timeout_ms_invalid");
      if (!Array.isArray(summary.timeoutObservations)) errors.push("timeout_observations_required");
      else if (summary.timeoutObservations.length !== summary.timeoutCount)
        errors.push("timeout_observation_count_mismatch");
      else
        summary.timeoutObservations.forEach((observation: any) => {
          if (
            observation?.latencyObservation !== "lower_bound" ||
            !Number.isFinite(observation?.elapsedMs) ||
            observation.elapsedMs < 60000
          )
            errors.push("timeout_observation_invalid");
        });
    }
  }
  return { valid: errors.length === 0, errors: errors.slice(0, 20) };
}

function diskIoService(labels: Record<string, string | undefined>): string {
  return (
    labels.service ??
    labels.container ??
    labels.container_name ??
    labels.name ??
    labels.component ??
    "unknown"
  ).replace(/^(?:\/|.*-)([a-z][a-z0-9-]+)-\d+$/, "$1");
}

function hostDiskDevices(sampleGroups: MetricSample[][]): string[] {
  const configured = (process.env.PARKBENCH_REQUIRED_DISK_DEVICES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[a-zA-Z0-9_.-]+$/.test(value));
  if (configured.length) return configured;
  const discovered = [
    ...new Set(
      sampleGroups.flatMap((samples) =>
        samples.map((sample) => sample.labels.device ?? sample.labels.disk ?? "host")
      )
    )
  ];
  return discovered.length ? discovered : ["host"];
}

function hostDiskSeries(
  samples: MetricSample[],
  devices: string[]
): Array<{
  key: string;
  samples: MetricSample[];
}> {
  return devices.map((key) => ({
    key,
    samples: samples.filter(
      (sample) => (sample.labels.device ?? sample.labels.disk ?? "host") === key
    )
  }));
}

async function waitUntil(timestampMs: number): Promise<void> {
  const wait = timestampMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

function isMetricSink(client: PrometheusClient): client is PrometheusClient & MetricSink {
  return typeof (client as any).append === "function";
}

function normalizedDatabaseStartup(
  variant: Variant,
  scenarioDefaults: Record<string, string | number | boolean> = {}
): DatabaseStartupParameters | undefined {
  const explicit = Object.entries(variant.parameters).filter(([name]) =>
    DATABASE_BROKER_PARAMETERS.has(name)
  );
  if (
    !variant.databaseStartup &&
    explicit.length === 0 &&
    !Object.keys(scenarioDefaults).some((name) => DATABASE_BROKER_PARAMETERS.has(name))
  )
    return undefined;
  const initial =
    variant.databaseStartup ??
    resolveDatabaseStartup(
      { startupFile: { status: "absent" }, entries: [] },
      scenarioDefaults,
      variant.parameters
    );
  validateDatabaseStartupParameters(initial);
  canonicalParameterValues(
    Object.fromEntries(initial.parameters.map((p) => [p.name, p.displayValue]))
  );
  const parameters = initial.parameters.map((parameter) => ({
    ...parameter,
    name: databaseParameterDefinition(parameter.name)?.name ?? parameter.name
  }));
  for (const [name, value] of explicit) {
    validateBrokerParameter(name, String(value));
    const existing = parameters.find((parameter) => parameter.name === name);
    if (existing) {
      if (existing.displayValue !== String(value))
        throw new Error(`database_startup_conflict:${name}`);
    } else
      parameters.push({
        name,
        displayValue: String(value),
        source: "queued",
        overrides: [],
        sourceReference: "experiment_variant",
        applicability: "database_broker",
        verification: "pending"
      });
  }
  return validateDatabaseStartupParameters({ ...initial, parameters });
}

export function qualifyRunServiceUrl(
  url: string,
  bundle: ComposeBundle,
  environment: NodeJS.ProcessEnv = process.env
): string {
  try {
    const parsed = new URL(url);
    const hostPort = bundle.observerPorts?.[parsed.hostname];
    const runObserverService = ["loadgen", "db-observer", "pas-observer", "file-sampler"].includes(
      parsed.hostname
    );
    if (runObserverService && environment.PARKBENCH_CONTAINER_PATH_ROOT) {
      parsed.hostname = `${bundle.projectName}-${parsed.hostname}`;
    } else if (hostPort !== undefined) {
      parsed.hostname = "127.0.0.1";
      parsed.port = String(hostPort);
    } else if (runObserverService) parsed.hostname = `${bundle.projectName}-${parsed.hostname}-1`;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function readinessServiceFromError(error: unknown): string | undefined {
  const message = String(error);
  if (!message.includes("run_readiness_timeout")) return undefined;
  return message.split(":").slice(1).join(":") || "readiness";
}
