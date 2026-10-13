import { validateParameterConfiguration } from "../../../../packages/contracts/src/matrix-expansion";
import { createMetricSelectionService } from "../comparisons/metric-selection-service";
import { createNamedLatchProjection } from "../comparisons/named-latch-projection";
import { resolveDashboardReferences } from "../../../../packages/dashboards/src/legacy-references";
import {
  buildComparison,
  normalizeComparisonSelection,
  comparisonSelectionPage,
  selectedRunIds,
  comparisonTablePage,
  recordedScenario
} from "../comparisons/service";
import { streamComparisonCsv } from "../comparisons/export";
import type {
  ComparisonSelection,
  SummaryReader,
  SummaryScheduler
} from "../../../../packages/contracts/src/comparison";
import crypto from "node:crypto";
import { alignedRange, timelineFromRun } from "../grafana";
import {
  CatalogAsset,
  ComparisonView,
  ControlExperimentView,
  ControlRunView,
  DashboardContext,
  DatabaseParameterDefinition,
  ImageOperation,
  MatrixCell,
  MatrixPreview,
  MatrixPreviewRequest,
  MatrixPreviewRequestV2,
  ScenarioVersionRecord
} from "../../../../packages/contracts/src";
import {
  expandMatrix,
  normalizeMatrixParameterNames,
  normalizeRunName,
  resolveDatabaseStartup
} from "../../../../packages/contracts/src/matrix-expansion";
import {
  checkReadableSeedDirectory,
  inspectSeedStartupFile
} from "../../../../packages/compose-runner/src/input-checks";
import { Scenario } from "../../../../packages/contracts/src/scenario";
import { Repositories } from "../db/repositories";
import { ControlUiRepository } from "../storage/control-ui-repository";
import { ScenarioCatalog } from "../scenarios/catalog";
import { RunCoordinator } from "../runs/coordinator";
import { Run } from "../../../../packages/contracts/src/run";
import { ExperimentRequest } from "../../../../packages/contracts/src/experiment";
import { validateExperimentRequest } from "../../../../packages/compose-runner/src/preflight";
import { hostCapacity } from "../preflight/capacity";
import { ControlledImageRunner } from "../image-operations/image-operation-runner";
import { classifyQueueFailure, QUEUE_RETRY_DELAYS_MS } from "../queue/queue-service";
import {
  validateScenarioDatabaseParameterDefinitions,
  validateRequiredMeasurements
} from "../catalog/scenario-validation";
import { validateScenario } from "../../../../packages/contracts/src/validator";
import {
  createDashboardContext,
  deriveDashboardTimeRange
} from "../comparisons/dashboard-context-service";
import { resolveManagedInputPath } from "../catalog/managed-input-path";
import { ScenarioFileSource } from "../catalog/scenario-source";
import { ManagedRootFileDiscovery } from "../catalog/file-discovery";
import { assertScenarioArchiveCompatible } from "../catalog/archive-contents";
import { nextRunNames } from "../runs/run-numbering";
import { allocateNameDerivedId } from "../runs/name-derived-id";
import {
  databaseParameterOptions,
  databaseParameterInput,
  validateDatabaseParameterConfiguration,
  validateDatabaseParameterPaths
} from "../../../../packages/contracts/src/database-parameter-options";
import {
  DATABASE_RUN_CONTROL_DEFINITIONS,
  resolveDatabaseRunControls
} from "../../../../packages/contracts/src/database-run-controls";
import { redactSecrets, runtimeSecretValues } from "../../../../packages/contracts/src/redaction";
import {
  DATABASE_LATENCY_PARAMETER,
  PLATFORM_RUN_PARAMETER_DEFINITIONS
} from "../../../../packages/contracts/src/run-parameters";

export { QUEUE_RETRY_DELAYS_MS } from "../queue/queue-service";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const pageSize = (value: unknown, fallback = 50) =>
  Math.max(1, Math.min(250, Number(value) || fallback));

const defaultInputRefs = {
  databaseImage: "openedge-db:fixture",
  pasImage: "openedge-pas:fixture",
  credentialRef: "credential:pas-metrics-fixture",
  seed: "input:seed",
  applicationArchive: "input:archive"
};
type InputReferences = Partial<typeof defaultInputRefs>;

const allowedMatrixInputKeys = new Set(["seed", "applicationArchive"]);

function sanitizeMatrixInputs(inputs: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (["databaseImage", "pasImage", "credentialRef"].includes(key))
      throw new Error(`configured_input_override_forbidden:${key}`);
    if (!allowedMatrixInputKeys.has(key)) throw new Error(`input_key_not_allowed:${key}`);
    if (typeof value !== "string") throw new Error(`input_reference_must_be_string:${key}`);
    result[key] = value;
  }
  return result;
}

export interface ControlUiRuntime {
  prometheusUrl?: string;
  summaryReader?: SummaryReader;
  summaryScheduler?: SummaryScheduler;
  repositories: Repositories;
  controlRepository: ControlUiRepository;
  scenarios: ScenarioCatalog;
  coordinator: RunCoordinator;
  testMode?: boolean;
  grafanaUrl?: string;
  coordinatorHealth?: () => Promise<boolean | undefined>;
  prometheusHealth?: () => Promise<boolean | undefined>;
  inspectImage?: (image: string) => Promise<boolean>;
  diskIoSources?: () => Promise<{ cadvisor: boolean; nodeExporterBlockDevice: boolean }>;
  observerValidate?: (declaration: any) => void;
  inputRoot?: string;
  inputRefs?: InputReferences;
  discoveryRoots?: Partial<
    Record<"scenarios" | "workloads" | "observers" | "seeds" | "archives", string>
  >;
  supportImages?: { loadgen: string; observer: string };
  databaseCapabilities?: { version?: string; features?: string[] };
  imageRunner?: ControlledImageRunner;
  grafanaAvailability?: () => "available" | "degraded" | "unavailable";
  dashboardProbe?: (context: DashboardContext) => Promise<{
    grafana: boolean;
    prometheus: boolean;
    labelsValid: boolean;
    metricsAvailability?: NonNullable<DashboardContext["health"]>["metricsAvailability"];
  }>;
}

export class ControlUiService {
  private readonly queueOrdinals = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribeExperimentFinished: () => void;
  private queueEnabled = false;
  private closed = false;
  private queueStartPromise?: Promise<{
    activeExperiment?: string;
    queued: ControlRunView[];
    started?: string;
  }>;

  constructor(private readonly runtime: ControlUiRuntime) {
    this.unsubscribeExperimentFinished = this.runtime.coordinator.onExperimentFinished(() => {
      if (this.queueEnabled && !this.closed) void this.continueQueue();
    });
    for (const experiment of this.runtime.controlRepository.listControlExperiments())
      this.queueOrdinals.set(experiment.id, experiment.queueOrdinal);
    for (const experiment of this.runtime.controlRepository.listControlExperiments())
      this.restoreRetry(experiment.id);
  }

  close(): void {
    this.closed = true;
    this.queueEnabled = false;
    this.unsubscribeExperimentFinished();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private async continueQueue(): Promise<void> {
    try {
      // Fast completion can arrive before the start response releases its dispatch lock.
      // Reusing that response would lose the wakeup and leave subsequent work queued.
      await this.queueStartPromise;
      if (this.queueEnabled && !this.closed) await this.startQueue();
    } catch (error) {
      if (!this.closed)
        console.error(
          "queue_continuation_failed",
          redactSecrets(String(error), runtimeSecretValues())
        );
    }
  }

  private inputRefs(): InputReferences {
    const configured = Object.fromEntries(
      Object.entries(this.runtime.inputRefs ?? {}).filter(
        ([, value]) => typeof value === "string" && value.length > 0
      )
    ) as InputReferences;
    return {
      ...(this.runtime.testMode ? defaultInputRefs : {}),
      ...configured
    };
  }

  private resolveManagedInput(reference: string | undefined, kind: "seed" | "archive"): string {
    if (!reference) throw new Error(`asset_not_selectable:${kind}`);
    if (!reference.startsWith("input:")) return reference;
    const asset = this.listAssets({ kind }).find(
      (candidate) => candidate.immutableRef === reference
    );
    return resolveManagedInputPath(asset, reference, kind, this.runtime.discoveryRoots ?? {});
  }

  private inspectStartupSource(
    seedReference: unknown,
    additionalFiles: string[] = []
  ): {
    startupFile: { status: "absent" } | { status: "present"; relativePath: "startup.pf" };
    entries: Array<{ name: string; value: string; line: number }>;
    databaseName?: string;
    expandedParameterFiles?: string[];
  } {
    const reference = typeof seedReference === "string" ? seedReference : this.inputRefs().seed;
    if (!reference) throw new Error("seed_reference_required");
    if (
      this.runtime.testMode &&
      reference.startsWith("input:") &&
      !this.listAssets({ kind: "seed" }).some((asset) => asset.immutableRef === reference)
    )
      return { startupFile: { status: "absent" }, entries: [] };
    const location = this.resolveManagedInput(reference, "seed");
    const seed = checkReadableSeedDirectory(location);
    const inspection = inspectSeedStartupFile(location, additionalFiles);
    return {
      expandedParameterFiles: inspection.expandedParameterFiles,
      startupFile: inspection.startupFile,
      entries: inspection.parsed.entries,
      databaseName: seed.databaseName
    };
  }

  /** Records the seed's name and database name next to its resolved directory. */
  private withSeedIdentity<T extends Record<string, string | undefined>>(inputs: T): T {
    if (!inputs.seed) return inputs;
    const seed = checkReadableSeedDirectory(inputs.seed);
    return {
      ...inputs,
      seedName: seed.name,
      databaseName: seed.databaseName
    };
  }

  private restoreRetry(experimentId: string): void {
    const retryAt = this.runtime.controlRepository
      .listRunMetadata(experimentId)
      .filter((run) => run.queueState === "QUEUED" && run.nextRetryAt)
      .map((run) => Date.parse(run.nextRetryAt!))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (retryAt !== undefined) this.scheduleRetry(experimentId, retryAt);
  }

  private scheduleRetry(experimentId: string, retryAt: number): void {
    const existing = this.retryTimers.get(experimentId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, retryAt - Date.now());
    const timer = setTimeout(() => {
      this.retryTimers.delete(experimentId);
      void this.startQueue().catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.retryTimers.set(experimentId, timer);
  }

  syncExistingScenarios(): void {
    // Kept for callers compiled against the old API; disk discovery needs no sync.
  }

  private parameterDefinitionsFor(scenario: Scenario): DatabaseParameterDefinition[] {
    const capabilities = databaseParameterOptions(this.runtime.databaseCapabilities);
    const supplied = (
      scenario as Scenario & { parameterDefinitions?: DatabaseParameterDefinition[] }
    ).parameterDefinitions;
    if (supplied?.length)
      validateScenarioDatabaseParameterDefinitions(supplied, this.runtime.databaseCapabilities);
    const brokerDefinitions: DatabaseParameterDefinition[] = capabilities.parameters
      .filter((option) => option.available)
      .map((option) => ({
        id: `param_${option.name.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        canonicalName: option.name,
        type:
          option.kind === "flag" ? "boolean" : option.kind === "decimal" ? "number" : option.kind,
        minimum: option.allowedValues?.includes(0) ? 0 : option.minimum,
        maximum: option.maximum,
        allowedValues: option.values,
        unit: option.unit,
        description: option.description,
        source: "database-parameter-options.v2",
        matrixAllowed: true,
        secret: false as const,
        definitionVersion: capabilities.registryVersion,
        step: option.increment
      }));
    const definitions = new Map(
      [
        ...brokerDefinitions,
        ...DATABASE_RUN_CONTROL_DEFINITIONS,
        ...PLATFORM_RUN_PARAMETER_DEFINITIONS
      ].map((definition) => [definition.canonicalName, definition])
    );
    for (const definition of supplied ?? []) {
      const native = definitions.get(definition.canonicalName);
      definitions.set(definition.canonicalName, {
        ...native,
        ...definition,
        description:
          native?.description && native.description !== definition.description
            ? `${native.description} ${definition.description}`
            : definition.description,
        minimum: definition.minimum ?? native?.minimum,
        maximum: definition.maximum ?? native?.maximum,
        step: definition.step ?? native?.step,
        secret: false
      });
    }
    return [...definitions.values()];
  }

  saveScenario(
    _input: unknown,
    _suppliedDefinitions?: DatabaseParameterDefinition[]
  ): ScenarioVersionRecord {
    throw new Error("operation_retired");
  }

  listScenarios(): ScenarioVersionRecord[] {
    return new ScenarioFileSource(this.runtime.discoveryRoots?.scenarios)
      .list()
      .filter((entry) => entry.sourceStatus === "AVAILABLE")
      .map((entry) => this.scenarioFromSource(entry.id));
  }

  getScenario(id: string, version: string): ScenarioVersionRecord | undefined {
    try {
      const source = new ScenarioFileSource(this.runtime.discoveryRoots?.scenarios).getByDeclaredId(
        id,
        version
      );
      return this.scenarioFromSource(source.entry.id);
    } catch (error) {
      if (String(error).includes("scenario_source_ambiguous")) throw error;
      if (this.runtime.testMode) {
        const fixture = this.runtime.scenarios.get(id, version);
        if (fixture)
          return {
            id,
            version,
            document: fixture as unknown as Record<string, unknown>,
            parameterDefinitions: this.parameterDefinitionsFor(fixture),
            state: "READY",
            createdAt: now()
          };
      }
      return undefined;
    }
  }

  private scenarioFromSource(sourceId: string): ScenarioVersionRecord {
    const { scenario } = new ScenarioFileSource(this.runtime.discoveryRoots?.scenarios).get(
      sourceId
    );
    validateRequiredMeasurements(scenario);
    return {
      id: scenario.id,
      version: scenario.version,
      document: scenario as unknown as Record<string, unknown>,
      parameterDefinitions: this.parameterDefinitionsFor(scenario),
      state: "READY",
      createdAt: now()
    };
  }

  registerAsset(_input: Partial<CatalogAsset> & Pick<CatalogAsset, "kind" | "name">): CatalogAsset {
    throw new Error("operation_retired");
  }

  importAsset(_input: Record<string, unknown>): CatalogAsset {
    throw new Error("operation_retired");
  }

  listAssets(filters: Record<string, string | undefined> = {}): CatalogAsset[] {
    return new ManagedRootFileDiscovery(this.runtime.discoveryRoots ?? {})
      .discoverAll()
      .flatMap((result) =>
        result.items.map(
          (item) =>
            ({ ...item, createdAt: item.discoveredAt, updatedAt: item.lastSeenAt }) as CatalogAsset
        )
      )
      .filter((asset) => !filters.kind || asset.kind === filters.kind)
      .filter((asset) => !filters.category || asset.category === filters.category)
      .filter((asset) => !filters.name || asset.name.includes(filters.name));
  }

  getAsset(assetId: string): CatalogAsset | undefined {
    return this.listAssets().find(
      (asset) => asset.id === assetId || asset.immutableRef === assetId
    );
  }

  startImageOperation(_input: {
    kind: "BUILD" | "VERIFY";
    stage?: string;
    inputAssetIds?: string[];
    expectedContracts?: string[];
    outputProfile?: string;
    commandId?: string;
  }): ImageOperation {
    throw new Error("operation_retired");
  }

  getImageOperation(operationId: string): ImageOperation | undefined {
    return this.runtime.controlRepository.getOperation(operationId);
  }

  cancelImageOperation(_operationId: string): ImageOperation {
    throw new Error("operation_retired");
  }

  retryImageOperation(_operationId: string, _commandId?: string): ImageOperation {
    throw new Error("operation_retired");
  }

  preview(
    request: MatrixPreviewRequest | MatrixPreviewRequestV2,
    pageToken?: string,
    requestedPageSize?: number
  ): MatrixPreview {
    const sourceId = (request as MatrixPreviewRequestV2).scenarioSourceId;
    const scenarioRef = (request as MatrixPreviewRequest).scenario;
    const scenario = sourceId
      ? this.scenarioFromSource(sourceId)
      : scenarioRef
        ? this.getScenario(scenarioRef.id, scenarioRef.version)
        : undefined;
    if (!scenario) throw new Error("scenario_not_found");
    const normalizedRequest: MatrixPreviewRequest = normalizeMatrixParameterNames({
      ...request,
      displayName: request.runName.trim(),
      runName: normalizeRunName(request.runName),
      scenario: { id: scenario.id, version: scenario.version },
      scenarioSourceId: sourceId,
      inputs: sanitizeMatrixInputs(request.inputs)
    });
    if (!this.runtime.testMode) {
      const archive =
        normalizedRequest.inputs?.applicationArchive ?? this.inputRefs().applicationArchive;
      if (typeof archive === "string")
        assertScenarioArchiveCompatible(
          this.resolveManagedInput(archive, "archive"),
          validateScenario(scenario.document)
        );
    }
    const startupSource = this.inspectStartupSource(normalizedRequest.inputs?.seed);
    const scenarioValues = Object.fromEntries(
      scenario.parameterDefinitions
        .filter((definition) => definition.defaultValue !== undefined)
        .map((definition) => [definition.canonicalName, definition.defaultValue!])
    ) as Record<string, string | number | boolean>;
    const cells = this.assignRunNames(
      expandMatrix(normalizedRequest, scenario.parameterDefinitions).map((cell) => {
        const databaseRunControls = resolveDatabaseRunControls(
          scenarioValues,
          cell.values,
          {
            ...this.runtime.databaseCapabilities,
            version:
              this.runtime.databaseCapabilities?.version ??
              (this.runtime.testMode ? "12.8.11" : "unverified")
          },
          normalizedRequest.fixedOverrides ?? {}
        );
        databaseRunControls.requirements = { namedLatchRequired: true, observerProtocolVersion: 4 };
        const databaseStartup = resolveDatabaseStartup(
          cell.effectiveConfiguration["-pf"] !== undefined
            ? this.inspectStartupSource(normalizedRequest.inputs?.seed, [
                String(cell.effectiveConfiguration["-pf"])
              ])
            : startupSource,
          scenarioValues,
          cell.values,
          normalizedRequest.fixedOverrides ?? {}
        );
        validateDatabaseParameterConfiguration(
          Object.fromEntries(
            databaseStartup.parameters.map((p) => [
              p.name,
              databaseParameterInput(p.name, p.displayValue)
            ])
          ),
          databaseParameterOptions(this.runtime.databaseCapabilities)
        );
        validateDatabaseParameterPaths(
          Object.fromEntries(
            databaseStartup.parameters.map((p) => [
              p.name,
              databaseParameterInput(p.name, p.displayValue)
            ])
          ),
          databaseStartup.databaseName
        );
        const effectiveConfiguration = {
          ...cell.effectiveConfiguration,
          ...Object.fromEntries(
            databaseStartup.parameters.map((item) => [
              item.name,
              databaseParameterInput(item.name, item.displayValue)
            ])
          )
        };
        validateParameterConfiguration(scenario.parameterDefinitions, effectiveConfiguration);
        return { ...cell, databaseStartup, databaseRunControls, effectiveConfiguration };
      }),
      normalizedRequest.runName
    );
    const previewId = id("preview");
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.runtime.controlRepository.savePreview({
      id: previewId,
      request: normalizedRequest,
      cells,
      cellCount: cells.reduce((max, cell) => Math.max(max, cell.ordinal + 1), 0),
      runCount: cells.length,
      warning: {
        code: "matrix_submission_confirmation",
        message: `This submission will queue ${cells.length} runs. Confirm to continue.`
      },
      expiresAt,
      state: "VALID",
      reviewedRanges: []
    });
    return this.previewPage(
      this.runtime.controlRepository.getPreview(previewId)!,
      pageToken,
      requestedPageSize
    );
  }

  previewCells(previewId: string, pageToken?: string, requestedPageSize?: number): MatrixPreview {
    const preview = this.runtime.controlRepository.getPreview(previewId);
    if (!preview) throw new Error("preview_not_found");
    return this.previewPage(preview, pageToken, requestedPageSize);
  }

  private previewPage(
    preview: {
      id: string;
      request: MatrixPreviewRequest;
      cells: MatrixCell[];
      cellCount: number;
      runCount: number;
      warning: Record<string, string>;
      expiresAt: string;
      reviewedRanges: Array<[number, number]>;
    },
    pageToken?: string,
    requestedPageSize?: number
  ): MatrixPreview {
    if (Date.parse(preview.expiresAt) <= Date.now()) throw new Error("preview_expired");
    const start = Number(pageToken ?? 0);
    const size = pageSize(requestedPageSize);
    const items = preview.cells.slice(start, start + size);
    const next = start + size < preview.cells.length ? String(start + size) : undefined;
    this.runtime.controlRepository.markPreviewRangeReviewed(
      preview.id,
      start,
      start + items.length
    );
    const reviewedPreview = this.runtime.controlRepository.getPreview(preview.id) ?? preview;
    const reviewedRunCount = reviewedPreview.reviewedRanges.reduce(
      (total, [rangeStart, rangeEnd]) => total + Math.max(0, rangeEnd - rangeStart),
      0
    );
    return {
      previewId: preview.id,
      scenario: preview.request.scenario,
      cellCount: preview.cellCount,
      runCount: preview.runCount,
      confirmationRequired: true,
      warning: preview.warning as { code: string; message: string },
      cells: { items, nextPageToken: next, hasMore: Boolean(next) },
      review: {
        loadedRunCount: reviewedRunCount,
        complete: reviewedRunCount >= preview.runCount
      },
      expiresAt: preview.expiresAt
    };
  }

  submit(
    request: {
      previewId: string;
      confirm: boolean;
      executionPolicy?: string;
    },
    idempotencyKey?: string
  ): ControlExperimentView {
    if (idempotencyKey) {
      const existing = this.runtime.repositories.getIdempotency(
        "control-ui-submit",
        idempotencyKey
      );
      if (existing) return existing.response as ControlExperimentView;
    }
    if (!request.confirm) throw new Error("matrix_confirmation_required");
    const preview = this.runtime.controlRepository.getPreview(request.previewId);
    if (!preview) throw new Error("preview_not_found");
    if (Date.parse(preview.expiresAt) <= Date.now()) throw new Error("preview_expired");
    const reviewedRunCount = preview.reviewedRanges.reduce(
      (total, [start, end]) => total + Math.max(0, end - start),
      0
    );
    if (reviewedRunCount < preview.runCount) throw new Error("matrix_review_incomplete");
    const scenario = preview.request.scenarioSourceId
      ? this.scenarioFromSource(preview.request.scenarioSourceId)
      : this.getScenario(preview.request.scenario.id, preview.request.scenario.version);
    if (!scenario) throw new Error("scenario_not_found");
    // The source is read again at submission. A changed definition cannot leave
    // the reviewed matrix with values that are no longer legal.
    expandMatrix(preview.request, scenario.parameterDefinitions);
    const currentSource = preview.request.scenarioSourceId
      ? new ScenarioFileSource(this.runtime.discoveryRoots?.scenarios).get(
          preview.request.scenarioSourceId
        )
      : undefined;
    const requestedInputs = (preview.request.inputs ?? {}) as Record<string, string>;
    if (
      !this.runtime.testMode &&
      ["seed", "applicationArchive"].some((key) => !requestedInputs[key])
    )
      throw new Error("required_input_reference_missing");
    const configured = this.inputRefs();
    if (!configured.databaseImage || !configured.pasImage || !configured.credentialRef)
      throw new Error("configured_input_unavailable");
    const selectedInputs = { ...configured, ...requestedInputs };
    const inputs = this.runtime.testMode
      ? selectedInputs
      : this.withSeedIdentity({
          ...selectedInputs,
          seed: this.resolveManagedInput(selectedInputs.seed, "seed"),
          applicationArchive: this.resolveManagedInput(selectedInputs.applicationArchive, "archive")
        });
    if (!this.runtime.testMode)
      assertScenarioArchiveCompatible(
        inputs.applicationArchive!,
        validateScenario(scenario.document)
      );
    const variants = preview.cells.map((cell) => ({
      id: `cell-${cell.ordinal}-r${cell.repetition}`,
      name: cell.runName!,
      parameters: cell.effectiveConfiguration,
      databaseStartup: cell.databaseStartup,
      databaseRunControls: cell.databaseRunControls
    }));
    const legacyRequest: ExperimentRequest = {
      scheduleName: preview.request.displayName ?? preview.request.runName,
      scenario: { id: scenario.id, version: scenario.version },
      comparisonMode: "exploratory",
      repetitions: 1,
      variants,
      inputs: inputs as unknown as ExperimentRequest["inputs"]
    };
    this.runtime.repositories.client.db.exec("SAVEPOINT parkbench_submit");
    try {
      const expectedNames = this.assignRunNames(
        preview.cells,
        normalizeRunName(preview.request.runName)
      );
      if (expectedNames.some((cell, index) => cell.runName !== preview.cells[index]?.runName))
        throw new Error("run_name_conflict_repreview");
      const experiment = this.runtime.coordinator.createExperiment(
        legacyRequest,
        validateScenario(scenario.document),
        {
          base: normalizeRunName(preview.request.runName),
          names: preview.cells.map((cell) => cell.runName!)
        }
      );
      const queueOrdinal = this.runtime.controlRepository.listControlExperiments().length;
      this.runtime.controlRepository.saveExperiment({
        experimentId: experiment.id,
        previewId: preview.id,
        request: {
          ...preview.request,
          scenarioSourcePath: currentSource?.sourcePath,
          scenarioRelativePath: currentSource?.entry.relativePath,
          scenarioDeclaredId: scenario.id,
          scenarioDeclaredVersion: scenario.version,
          scenarioCapturedAt: experiment.createdAt
        },
        scenarioSnapshot: scenario.document,
        matrixSpec: {
          dimensions: preview.request.dimensions,
          repetitions: preview.request.repetitions
        },
        executionPolicy: request.executionPolicy ?? "default-local-serial",
        queueOrdinal,
        status: "QUEUED",
        createdAt: experiment.createdAt
      });
      const runs = this.runtime.repositories.listRuns(experiment.id);
      for (const [index, run] of runs.entries()) {
        const cell = preview.cells[index];
        run.name = cell.runName;
        run.environmentSnapshot = {
          ...run.environmentSnapshot,
          runName: cell.runName,
          databaseStartup: cell.databaseStartup,
          ...(cell.databaseRunControls
            ? { databaseRunControls: structuredClone(cell.databaseRunControls) }
            : {})
        };
        this.runtime.repositories.saveRun(run);
        this.runtime.controlRepository.saveRunMetadata({
          runId: run.id,
          experimentId: experiment.id,
          cellOrdinal: cell.ordinal,
          repetition: cell.repetition,
          values: cell.values,
          effectiveConfiguration: cell.effectiveConfiguration,
          snapshot: {
            runName: cell.runName,
            runNumber: run.environmentSnapshot?.runNumber,
            runNameBase: run.environmentSnapshot?.runNameBase,
            queuedAt: experiment.createdAt,
            scenario: scenario.document,
            scenarioSourceId: preview.request.scenarioSourceId,
            scenarioSourcePath: currentSource?.sourcePath,
            scenarioRelativePath: currentSource?.entry.relativePath,
            scenarioDeclaredId: scenario.id,
            scenarioDeclaredVersion: scenario.version,
            scenarioCapturedAt: experiment.createdAt,
            scheduleName: preview.request.displayName ?? preview.request.runName,
            requiredMeasurements: (scenario.document as any).requiredMeasurements ?? [],
            assets: inputs,
            parameters: cell.effectiveConfiguration,
            databaseStartup: cell.databaseStartup,
            ...(cell.databaseRunControls
              ? { databaseRunControls: structuredClone(cell.databaseRunControls) }
              : {}),
            matrixCell: cell.ordinal,
            repetition: cell.repetition,
            executionPolicy: request.executionPolicy ?? "default-local-serial"
          },
          queueState: "QUEUED",
          retryCount: 0,
          updatedAt: now()
        });
      }
      const result = this.getExperiment(experiment.id)!;
      if (idempotencyKey)
        this.runtime.repositories.saveIdempotency("control-ui-submit", idempotencyKey, 202, result);
      this.runtime.repositories.client.db.exec("RELEASE SAVEPOINT parkbench_submit");
      return result;
    } catch (error) {
      this.runtime.repositories.client.db.exec("ROLLBACK TO SAVEPOINT parkbench_submit");
      this.runtime.repositories.client.db.exec("RELEASE SAVEPOINT parkbench_submit");
      throw error;
    }
  }

  async startQueue(): Promise<{
    activeExperiment?: string;
    queued: ControlRunView[];
    started?: string;
  }> {
    if (this.closed) throw new Error("queue_closed");
    this.queueEnabled = true;
    if (this.queueStartPromise) return this.queueStartPromise;
    this.queueStartPromise = this.startQueueInternal();
    try {
      return await this.queueStartPromise;
    } finally {
      this.queueStartPromise = undefined;
    }
  }

  private async startQueueInternal(): Promise<{
    activeExperiment?: string;
    queued: ControlRunView[];
    started?: string;
  }> {
    const experiments = this.runtime.controlRepository.listControlExperiments();
    const active = experiments.find((experiment) =>
      ["RUNNING"].includes(this.syncExperimentStatus(experiment.id))
    );
    if (active) return { activeExperiment: active.id, queued: this.listQueue() };
    for (const candidate of experiments) {
      if (this.syncExperimentStatus(candidate.id) !== "QUEUED") continue;
      const candidateRuns = this.runtime.controlRepository.listRunMetadata(candidate.id);
      if (
        candidateRuns.length > 0 &&
        candidateRuns.every((run) => run.queueState === "CANCELLED")
      ) {
        this.runtime.controlRepository.updateControlExperiment(candidate.id, {
          status: "CANCELLED"
        });
        this.runtime.repositories.updateExperimentStatus(candidate.id, "CANCELLED", now());
      }
    }
    const next =
      experiments.find((experiment) => this.syncExperimentStatus(experiment.id) === "QUEUED") ??
      experiments.find((experiment) => this.syncExperimentStatus(experiment.id) === "BLOCKED");
    if (next) {
      if (process.env.PARKBENCH_TEMP_CAPACITY === "1") {
        const existingRetryAt = this.runtime.controlRepository
          .listRunMetadata(next.id)
          .map((run) => (run.nextRetryAt ? Date.parse(run.nextRetryAt) : undefined))
          .filter((value): value is number => value !== undefined && Number.isFinite(value))
          .sort((left, right) => left - right)[0];
        if (existingRetryAt !== undefined && existingRetryAt > Date.now())
          return { queued: this.listQueue() };
        const delay =
          QUEUE_RETRY_DELAYS_MS[
            Math.min(
              this.runtime.controlRepository.listRunMetadata(next.id)[0]?.retryCount ?? 0,
              QUEUE_RETRY_DELAYS_MS.length - 1
            )
          ];
        for (const queuedRun of this.runtime.controlRepository.listRunMetadata(next.id)) {
          this.runtime.controlRepository.saveRunMetadata({
            runId: queuedRun.id,
            ...queuedRun,
            queueState: "QUEUED",
            blockedReason: "temporary_host_capacity",
            nextRetryAt: new Date(Date.now() + delay).toISOString(),
            retryCount: queuedRun.retryCount + 1,
            updatedAt: now()
          });
        }
        const retryAt = Date.now() + delay;
        this.scheduleRetry(next.id, retryAt);
        return { queued: this.listQueue() };
      }
      try {
        await this.preflightExperiment(next);
      } catch (error) {
        if (this.closed) return { queued: [] };
        const reason = String(error);
        if (classifyQueueFailure(error) === "temporary_capacity") {
          const currentRetry =
            this.runtime.controlRepository.listRunMetadata(next.id)[0]?.retryCount ?? 0;
          const delay =
            QUEUE_RETRY_DELAYS_MS[Math.min(currentRetry, QUEUE_RETRY_DELAYS_MS.length - 1)];
          const retryAt = Date.now() + delay;
          for (const queuedRun of this.runtime.controlRepository.listRunMetadata(next.id))
            this.runtime.controlRepository.saveRunMetadata({
              runId: queuedRun.id,
              ...queuedRun,
              queueState: "QUEUED",
              blockedReason: reason,
              nextRetryAt: new Date(retryAt).toISOString(),
              retryCount: queuedRun.retryCount + 1,
              updatedAt: now()
            });
          this.scheduleRetry(next.id, retryAt);
          return { queued: this.listQueue() };
        }
        this.runtime.controlRepository.updateControlExperiment(next.id, { status: "BLOCKED" });
        for (const queuedRun of this.runtime.controlRepository.listRunMetadata(next.id)) {
          this.runtime.controlRepository.saveRunMetadata({
            runId: queuedRun.id,
            ...queuedRun,
            state: "BLOCKED",
            queueState: "BLOCKED",
            blockedReason: reason,
            updatedAt: now()
          } as any);
        }
        return { queued: this.listQueue() };
      }
      if (this.closed) return { queued: [] };
      for (const queuedRun of this.runtime.controlRepository.listRunMetadata(next.id)) {
        if (queuedRun.queueState !== "BLOCKED") continue;
        this.runtime.controlRepository.saveRunMetadata({
          runId: queuedRun.id,
          ...queuedRun,
          queueState: "QUEUED",
          blockedReason: undefined,
          nextRetryAt: undefined,
          updatedAt: now()
        });
      }
      this.runtime.coordinator.startExperiment(next.id);
      this.runtime.controlRepository.updateControlExperiment(next.id, { status: "RUNNING" });
      return { activeExperiment: next.id, started: next.id, queued: this.listQueue() };
    }
    this.queueEnabled = false;
    return { queued: this.listQueue() };
  }

  private async preflightExperiment(record: any): Promise<void> {
    const scenario = record.scenarioSnapshot as Scenario;
    const firstRun = this.runtime.controlRepository.listRunMetadata(record.id)[0];
    const inputs = this.runtime.repositories.getExperiment(record.id)?.inputs;
    if (!inputs) throw new Error("experiment_inputs_missing");
    if (!this.runtime.testMode)
      assertScenarioArchiveCompatible(inputs.applicationArchive, scenario);
    const request: ExperimentRequest = {
      scenario: { id: scenario.id, version: scenario.version },
      comparisonMode: "exploratory",
      repetitions: 1,
      variants: [
        {
          id: "preflight",
          name: "queue preflight",
          parameters: firstRun?.effectiveConfiguration ?? {}
        }
      ],
      inputs
    };
    const host = hostCapacity();
    const dockerAvailable = this.runtime.testMode
      ? true
      : (await this.runtime.coordinatorHealth?.()) !== false;
    const prometheusAvailable = this.runtime.testMode
      ? true
      : (await this.runtime.prometheusHealth?.()) !== false;
    const supportImages = this.runtime.supportImages ?? { loadgen: "", observer: "" };
    const images = [
      request.inputs.databaseImage,
      request.inputs.pasImage,
      supportImages.loadgen,
      supportImages.observer
    ];
    if (images.some((image) => !image)) throw new Error("support_image_reference_required");
    if (!this.runtime.testMode && this.runtime.inspectImage) {
      const inspectable = await Promise.all(
        images.map((image) => this.runtime.inspectImage!(image))
      );
      if (inspectable.some((value) => !value)) throw new Error("image_not_inspectable");
    }
    const diskIo = this.runtime.testMode
      ? { cadvisor: true, nodeExporterBlockDevice: true }
      : await this.runtime.diskIoSources?.();
    if (!diskIo) throw new Error("disk_io_sources_unavailable");
    validateExperimentRequest(request, scenario, {
      frozenDatabaseStartup: true,
      databaseCapabilities: {
        version:
          this.runtime.databaseCapabilities?.version ??
          (this.runtime.testMode ? "12.8.11" : "unverified"),
        features: this.runtime.databaseCapabilities?.features ?? []
      },
      dockerAvailable,
      prometheusAvailable,
      imageInspectable: this.runtime.testMode || images.length > 0,
      diskIo,
      hostCpu: host.cpu,
      freeBytes: host.freeBytes,
      inputRoot: this.runtime.inputRoot,
      seedsRoot: this.runtime.discoveryRoots?.seeds,
      observerValidate: this.runtime.observerValidate
    });
  }

  listLifecycleRuns(): ControlRunView[] {
    const runs = this.runtime.controlRepository.listRunMetadata();
    const submissionOrder = new Map(
      this.runtime.controlRepository
        .listControlExperiments()
        .map((experiment) => [experiment.id, experiment.queueOrdinal])
    );
    return runs
      .map((run) => this.syncRunStatus(run))
      .sort((a, b) => {
        if (Boolean(a.startedAt) !== Boolean(b.startedAt)) return a.startedAt ? -1 : 1;
        const aTime = Date.parse(a.startedAt ?? a.queuedAt ?? "") || 0;
        const bTime = Date.parse(b.startedAt ?? b.queuedAt ?? "") || 0;
        return (
          bTime - aTime ||
          (submissionOrder.get(b.experimentId) ?? 0) - (submissionOrder.get(a.experimentId) ?? 0) ||
          a.cellOrdinal - b.cellOrdinal ||
          a.repetition - b.repetition ||
          a.id.localeCompare(b.id)
        );
      });
  }

  listQueue(): ControlRunView[] {
    return this.listLifecycleRuns().filter((run) => !this.isTerminal(run.queueState));
  }

  private assignRunNames(cells: MatrixCell[], base: string): MatrixCell[] {
    const names = nextRunNames(this.runtime.repositories, base, cells.length);
    return cells.map((cell, index) => ({ ...cell, runName: names[index].name }));
  }

  cancel(runId: string): ControlRunView {
    const metadata = this.runtime.controlRepository.getRunMetadata(runId);
    if (!metadata) throw new Error("run_not_found");
    const run = this.runtime.repositories.getRun(runId);
    if (run && this.isTerminal(run.state) && run.state !== "CANCELLED")
      throw new Error("run_already_terminal");
    if (run && !this.isTerminal(run.state)) this.runtime.coordinator.cancel(runId);
    metadata.queueState = "CANCELLED";
    metadata.state = "CANCELLED";
    metadata.nextRetryAt = undefined;
    metadata.updatedAt = now();
    this.runtime.controlRepository.saveRunMetadata({ runId: metadata.id, ...metadata });
    if (
      this.runtime.controlRepository
        .listRunMetadata(metadata.experimentId)
        .every((entry) => entry.queueState === "CANCELLED")
    ) {
      this.runtime.controlRepository.updateControlExperiment(metadata.experimentId, {
        status: "CANCELLED"
      });
      this.runtime.repositories.updateExperimentStatus(metadata.experimentId, "CANCELLED", now());
      const timer = this.retryTimers.get(metadata.experimentId);
      if (timer) clearTimeout(timer);
      this.retryTimers.delete(metadata.experimentId);
    }
    return metadata;
  }

  getExperiment(experimentId: string): ControlExperimentView | undefined {
    const record = this.runtime.controlRepository.getControlExperiment(experimentId);
    if (!record) return undefined;
    const runs = this.runtime.controlRepository
      .listRunMetadata(experimentId)
      .map((run) => this.syncRunStatus(run));
    const status = this.syncExperimentStatus(experimentId);
    return {
      id: experimentId,
      name:
        typeof record.request?.displayName === "string"
          ? record.request.displayName
          : typeof record.request?.runName === "string"
            ? record.request.runName
            : undefined,
      scenario: record.request.scenario,
      previewId: record.previewId,
      cellCount: record.matrixSpec.dimensions.reduce(
        (count: number, dimension: any) => count * dimension.values.length,
        1
      ),
      runCount: runs.length,
      status,
      queueOrdinal: record.queueOrdinal,
      baselineRunId: record.baselineRunId,
      createdAt: record.createdAt,
      runs
    };
  }

  hasExperiment(experimentId: string): boolean {
    return Boolean(this.runtime.controlRepository.getControlExperiment(experimentId));
  }

  listExperiments(filters: Record<string, string | undefined> = {}): ControlExperimentView[] {
    return this.runtime.controlRepository
      .listControlExperiments()
      .map((record) => this.getExperiment(record.id)!)
      .filter(
        (experiment) =>
          (!filters.status || experiment.status === filters.status) &&
          (!filters.scenario || experiment.scenario.id === filters.scenario)
      );
  }

  history(filters: Record<string, string | undefined> = {}): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    for (const experiment of this.runtime.controlRepository.listControlExperiments()) {
      const controlRuns = this.runtime.controlRepository.listRunMetadata(experiment.id);
      for (const controlRun of controlRuns) {
        const run = this.runtime.repositories.getRun(controlRun.id);
        const state = run?.state ?? controlRun.state;
        if (!this.isTerminal(state)) continue;
        const view = this.syncRunStatus(controlRun);
        if (filters.experiment && experiment.id !== filters.experiment) continue;
        if (filters.status && state !== filters.status) continue;
        if (filters.runId && run?.id !== filters.runId) continue;
        if (
          filters.scenario &&
          experiment.request.scenario.id !== filters.scenario &&
          `${experiment.request.scenario.id}@${experiment.request.scenario.version}` !==
            filters.scenario
        )
          continue;
        if (
          filters.workload &&
          !JSON.stringify((experiment.scenarioSnapshot as any)?.workload ?? {}).includes(
            filters.workload
          )
        )
          continue;
        if (filters.repetition && String(controlRun.repetition) !== filters.repetition) continue;
        // Runs recorded before Database Latency existed ran with latency 0.
        const filterConfiguration = {
          [DATABASE_LATENCY_PARAMETER]: 0,
          ...(controlRun.effectiveConfiguration ?? {})
        };
        if (
          filters.parameter &&
          !Object.keys(filterConfiguration).some(
            (name) =>
              name === filters.parameter ||
              `${name}=${filterConfiguration[name]}` === filters.parameter
          )
        )
          continue;
        if (
          filters.image &&
          !JSON.stringify(experiment.request.inputs ?? {}).includes(filters.image)
        )
          continue;
        if (
          filters.from &&
          run?.finishedAt &&
          Date.parse(run.finishedAt) < Date.parse(filters.from)
        )
          continue;
        if (filters.to && run?.finishedAt && Date.parse(run.finishedAt) > Date.parse(filters.to))
          continue;
        const artifacts = this.runtime.repositories.listArtifacts(controlRun.id);
        result.push({
          ...view,
          scenario: experiment.request.scenario,
          workload: (experiment.scenarioSnapshot as any)?.workload,
          images: {
            database: experiment.request.inputs?.databaseImage,
            pas: experiment.request.inputs?.pasImage,
            identity: run?.imageSnapshots
          },
          parameters: controlRun.effectiveConfiguration,
          repetition: controlRun.repetition,
          timestamps: {
            startedAt: run?.startedAt,
            finishedAt: run?.finishedAt,
            updatedAt: controlRun.updatedAt
          },
          status: state,
          terminalClassification: run?.failureKind,
          evidence: run
            ? {
                completeness: run.completeness,
                summary: run.summary,
                cleanupStatus: run.cleanupStatus,
                phaseBoundaries: run.phaseBoundaries,
                artifactCount: artifacts.length,
                artifactKinds: artifacts.map((artifact) => artifact.kind)
              }
            : {}
        });
      }
    }
    return result;
  }

  historyPage(
    filters: Record<string, string | undefined> = {},
    pageToken?: string,
    requestedPageSize?: number
  ): {
    items: Array<Record<string, unknown>>;
    nextPageToken?: string;
    hasMore: boolean;
  } {
    const size = pageSize(requestedPageSize);
    const offset = Math.max(0, Number(pageToken ?? 0) || 0);
    const page = this.runtime.controlRepository.queryHistory(filters, offset, size);
    const items = page.runIds
      .map((runId) => this.historyRecord(runId))
      .filter((record): record is Record<string, unknown> => Boolean(record));
    return {
      items,
      nextPageToken: page.hasMore ? String(offset + size) : undefined,
      hasMore: page.hasMore
    };
  }

  private ensureRunDashboard(run: Run): DashboardContext {
    return (
      this.runtime.controlRepository
        .listDashboards()
        .find((context) => context.runIds.length === 1 && context.runIds[0] === run.id) ??
      this.createDashboard({ experimentId: run.experimentId, runIds: [run.id] })
    );
  }

  private historyRecord(runId: string): Record<string, unknown> | undefined {
    const run = this.runtime.repositories.getRun(runId);
    const metadata = this.runtime.controlRepository.getRunMetadata(runId);
    if (!run || !metadata || !this.isTerminal(run.state)) return undefined;
    const experiment = this.runtime.controlRepository.getControlExperiment(metadata.experimentId);
    if (!experiment) return undefined;
    const artifacts = this.runtime.repositories.listArtifacts(runId);
    const view = this.syncRunStatus(metadata);
    const dashboard = this.ensureRunDashboard(run);
    return {
      ...view,
      dashboardContextId: dashboard.id,
      scenario: experiment.request.scenario,
      workload: (experiment.scenarioSnapshot as any)?.workload,
      images: {
        database: experiment.request.inputs?.databaseImage,
        pas: experiment.request.inputs?.pasImage,
        identity: run.imageSnapshots
      },
      parameters: metadata.effectiveConfiguration,
      repetition: metadata.repetition,
      timestamps: {
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        updatedAt: metadata.updatedAt
      },
      status: run.state,
      terminalClassification: run.failureKind,
      evidence: {
        completeness: run.completeness,
        summary: run.summary,
        cleanupStatus: run.cleanupStatus,
        phaseBoundaries: run.phaseBoundaries,
        artifactCount: artifacts.length,
        artifactKinds: artifacts.map((artifact) => artifact.kind)
      }
    };
  }

  historyDetail(runId: string): Record<string, unknown> | undefined {
    const run = this.runtime.repositories.getRun(runId);
    const metadata = this.runtime.controlRepository.getRunMetadata(runId);
    if (!run || !metadata) return undefined;
    const experiment = this.runtime.controlRepository.getControlExperiment(metadata.experimentId);
    if (!experiment) return undefined;
    const artifacts = this.runtime.repositories.listArtifacts(runId);
    if (this.isTerminal(run.state)) this.ensureRunDashboard(run);
    const dashboards = this.runtime.controlRepository
      .listDashboards()
      .filter((context) => context.runIds.includes(runId));
    return {
      run,
      queue: metadata,
      experiment: {
        id: experiment.experimentId,
        scenario: experiment.request.scenario,
        scenarioSnapshot: experiment.scenarioSnapshot,
        inputs: experiment.request.inputs,
        executionPolicy: experiment.executionPolicy
      },
      events: this.runtime.repositories.listEvents(runId),
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        downloadUrl: `/api/v1/runs/${runId}/artifacts/${artifact.id}`
      })),
      diagnostics: artifacts.filter((artifact) => artifact.kind === "diagnostics"),
      logs: artifacts.filter((artifact) => artifact.kind === "log"),
      resources: this.runtime.repositories.listResources(runId),
      dashboardContexts: dashboards
    };
  }

  async runDetail(runId: string): Promise<Record<string, unknown> | undefined> {
    const run = this.runtime.repositories.getRun(runId);
    if (!run) return undefined;
    const artifacts = this.runtime.repositories.listArtifacts(runId);
    const links: Array<{ label: string; url: string }> = artifacts.map((artifact) => ({
      label: artifact.kind,
      url: `/api/v1/runs/${runId}/artifacts/${artifact.id}`
    }));
    if (!links.some((link) => link.label === "artifact-index"))
      links.push({ label: "artifact index", url: `/api/v1/runs/${runId}/artifacts` });
    links.push({ label: "cleanup record", url: `/api/v1/history/runs/${runId}` });
    let dashboard = this.runtime.controlRepository
      .listDashboards()
      .find((context) => context.runIds.length === 1 && context.runIds[0] === runId);
    if (!dashboard) {
      dashboard = this.createDashboard({
        experimentId: run.experimentId,
        runIds: [runId],
        phase: run.phase,
        metricScope: ["workload", "latency", "resources", "database"]
      });
    }
    const dashboardContext = await this.getDashboardForUi(dashboard.id);
    return {
      ...run,
      comparisonEligibility: { eligible: true, reasons: [] },
      evidence: {
        failureReason: run.failureReason,
        links,
        artifacts,
        diagnostics: artifacts.filter((artifact) => artifact.kind === "diagnostics"),
        logs: artifacts.filter((artifact) => artifact.kind === "log"),
        cleanupStatus: run.cleanupStatus
      },
      dashboardContext
    };
  }

  createComparison(input: {
    experimentId?: string;
    baselineRunId?: string;
    variantRunIds: string[];
    authorizedRunIds?: string[];
  }): any {
    const selection = normalizeComparisonSelection({
      id: id("cmp"),
      experimentId: input.experimentId,
      baselineRunId: input.baselineRunId,
      variantRunIds: input.variantRunIds,
      createdAt: now(),
      selectionRevision: 1
    });
    const ids = selectedRunIds(selection),
      authorized = input.authorizedRunIds ? new Set(input.authorizedRunIds) : undefined;
    if (authorized && ids.some((id) => !authorized.has(id)))
      throw new Error("comparison_run_not_authorized");
    const experimentIds = new Set<string>();
    for (const id of ids) {
      const run = this.runtime.repositories.getRun(id);
      if (!run) throw new Error("comparison_run_not_found");
      experimentIds.add(run.experimentId);
    }
    if (selection.experimentId && !this.hasExperiment(selection.experimentId))
      throw new Error("comparison_experiment_not_found");
    const experimentId = experimentIds.size === 1 ? [...experimentIds][0] : undefined;
    selection.experimentId = experimentId;
    const dashboard = this.createDashboard({
      experimentId,
      runIds: ids,
      baselineRunId: selection.baselineRunId
    });
    selection.dashboardContextId = dashboard.id;
    this.runtime.controlRepository.saveComparison({
      ...selection,
      eligibility: selection.baselineRunId ? "VALID" : "DESCRIPTIVE_ONLY",
      eligibilityReasons: [],
      sharedContext: { experimentIds: [...experimentIds] },
      runs: []
    } as any);
    for (const id of ids) this.runtime.summaryScheduler?.schedule(id);
    return this.hydrateComparison(selection);
  }
  resolveComparisonSelection(idOrExperimentId: string): ComparisonSelection | undefined {
    const stored =
      this.runtime.controlRepository.getComparison(idOrExperimentId) ??
      this.runtime.controlRepository.latestComparisonForExperiment(idOrExperimentId);
    if (stored) return normalizeComparisonSelection(stored);
    if (!this.hasExperiment(idOrExperimentId)) return undefined;
    const metadata = this.runtime.controlRepository.getControlExperiment(idOrExperimentId),
      ids = this.runtime.repositories.listRuns(idOrExperimentId).map((r) => r.id);
    const created = this.createComparison({
      experimentId: idOrExperimentId,
      baselineRunId: metadata?.baselineRunId,
      variantRunIds: ids
    });
    return this.resolveComparisonSelection(created.id);
  }
  getComparison(idOrExperimentId: string, options: { cursor?: string; limit?: number } = {}): any {
    const selection = this.resolveComparisonSelection(idOrExperimentId);
    return selection ? this.hydrateComparison(selection, options) : undefined;
  }
  getComparisonSelectionPage(id: string, options: { cursor?: string; limit?: number } = {}): any {
    const selection = this.resolveComparisonSelection(id);
    if (!selection) return undefined;
    return {
      id: selection.id,
      contractVersion: "comparison.v2",
      baselineRunId: selection.baselineRunId,
      selectionRevision: selection.selectionRevision,
      totalSelectedRunCount: selectedRunIds(selection).length,
      selectionPage: comparisonSelectionPage(selection, options)
    };
  }
  getComparisonTables(
    id: string,
    runId: string,
    options: { cursor?: string; limit?: number } = {}
  ) {
    const selection = this.resolveComparisonSelection(id);
    return selection
      ? comparisonTablePage(selection, runId, this.comparisonSummaryReader(), options)
      : undefined;
  }
  private namedLatchProjection?: ReturnType<typeof createNamedLatchProjection>;
  async getComparisonMetricValues(id: string, request: unknown, signal?: AbortSignal) {
    // A projection reads an existing selection; it never creates a comparison implicitly.
    const stored = this.runtime.controlRepository.getComparison(id);
    if (!stored) throw new Error("comparison_not_found");
    const selection = normalizeComparisonSelection(stored);
    if (!this.namedLatchProjection && this.runtime.prometheusUrl)
      this.namedLatchProjection = createNamedLatchProjection({
        prometheusUrl: this.runtime.prometheusUrl
      });
    return createMetricSelectionService({
      reader: this.comparisonSummaryReader(),
      lookup: (id) => this.runtime.repositories.getRun(id),
      nativeProjection: this.namedLatchProjection
    })(selection, request, { signal });
  }
  comparisonSummaryReader(): SummaryReader {
    if (this.runtime.summaryReader) return this.runtime.summaryReader;
    const store = this.runtime.controlRepository.summaryReader();
    return {
      ...store,
      read: (id) => {
        const run = this.runtime.repositories.getRun(id);
        if (!run) throw new Error("run_not_found");
        const existing = this.runtime.repositories.getSummaryCache(id);
        if (existing) {
          if (existing.status !== "READY") this.runtime.summaryScheduler?.schedule(id);
          return this.runtime.repositories.getSummaryCache(id) ?? existing;
        }
        if (
          ![
            "SUCCEEDED",
            "INCOMPLETE",
            "THRESHOLD_FAILED",
            "FAILED",
            "CANCELLED",
            "INTERRUPTED"
          ].includes(run.state)
        )
          return { status: "UNAVAILABLE", reason: "run_not_finalized", retryable: false };
        this.runtime.summaryScheduler?.schedule(id);
        return (
          this.runtime.repositories.getSummaryCache(id) ?? {
            status: this.runtime.summaryScheduler ? "RECOMPUTING" : "LEGACY",
            reason: this.runtime.summaryScheduler ? "not_collected" : "legacy_semantics",
            retryAfterSeconds: 2
          }
        );
      }
    };
  }
  comparisonCsvStream(id: string): AsyncIterable<string> {
    const selection = this.resolveComparisonSelection(id);
    if (!selection) throw new Error("comparison_not_found");
    return streamComparisonCsv(selection, this.comparisonSummaryReader());
  }
  comparisonPending(id: string): boolean {
    const selection = this.resolveComparisonSelection(id);
    if (!selection) throw new Error("comparison_not_found");
    const reader = this.comparisonSummaryReader();
    for (const id of selectedRunIds(selection))
      if (reader.read(id).status === "RECOMPUTING") return true;
    return false;
  }
  private hydrateComparison(
    selection: ComparisonSelection,
    options: { cursor?: string; limit?: number } = {}
  ): any {
    const scenarios = new Map<string, ReturnType<typeof recordedScenario>>();
    return buildComparison(
      selection,
      this.comparisonSummaryReader(),
      (id) => this.runtime.repositories.getRun(id),
      {
        ...options,
        scenario: (run) => {
          const recorded = recordedScenario(run);
          if (recorded) return recorded;
          if (!scenarios.has(run.experimentId)) {
            const experiment = this.runtime.repositories.getExperiment(run.experimentId);
            scenarios.set(run.experimentId, experiment?.scenario);
          }
          return scenarios.get(run.experimentId);
        }
      }
    );
  }

  createDashboard(input: {
    experimentId?: string;
    runIds: string[];
    baselineRunId?: string;
    phase?: string;
    metricScope?: string[];
  }): DashboardContext {
    const knownRuns = input.runIds
      .map((runId) => this.runtime.repositories.getRun(runId))
      .filter(Boolean) as Run[];
    if (input.baselineRunId && !input.runIds.includes(input.baselineRunId))
      throw new Error("dashboard_baseline_not_in_run_scope");
    const experimentIds = [...new Set(knownRuns.map((run) => run.experimentId))];
    const requestedMetricScope = input.metricScope ?? ["workload", "pas", "database", "disk_io"];
    const scopedExperimentId =
      experimentIds.length > 1 ? undefined : (input.experimentId ?? experimentIds[0]);
    const existing = this.runtime.controlRepository
      .listDashboards()
      .find(
        (candidate) =>
          candidate.experimentId === scopedExperimentId &&
          candidate.baselineRunId === input.baselineRunId &&
          candidate.phase === input.phase &&
          JSON.stringify(candidate.runIds) === JSON.stringify(input.runIds) &&
          JSON.stringify(candidate.metricScope) === JSON.stringify(requestedMetricScope)
      );
    if (existing) return existing;
    const controlExperiment = scopedExperimentId
      ? this.runtime.controlRepository.getControlExperiment(scopedExperimentId)
      : undefined;
    const scheduleName =
      controlExperiment?.request.displayName ??
      controlExperiment?.request.runName ??
      (knownRuns[0]?.environmentSnapshot as any)?.scheduleName ??
      (knownRuns[0]?.environmentSnapshot as any)?.scenario?.id ??
      "run";
    const context = createDashboardContext({
      id: allocateNameDerivedId(scheduleName, (candidate) =>
        this.runtime.repositories.hasNamedId(candidate)
      ),
      experimentId: scopedExperimentId,
      experimentIds,
      runIds: input.runIds,
      baselineRunId: input.baselineRunId,
      phase: input.phase,
      metricScope: input.metricScope,
      grafanaAvailable: this.runtime.grafanaAvailability?.() !== "unavailable",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
    });
    context.availability = this.runtime.grafanaAvailability?.() ?? context.availability;
    context.grafanaUrl = this.runtime.grafanaUrl;
    this.runtime.controlRepository.saveDashboard(context);
    return context;
  }

  getDashboard(id: string): DashboardContext | undefined {
    const context = this.runtime.controlRepository.getDashboard(id);
    return context
      ? { ...context, dashboardRefs: resolveDashboardReferences(context.dashboardRefs) }
      : undefined;
  }

  async getDashboardForUi(id: string): Promise<DashboardContext | undefined> {
    const context = this.getDashboard(id);
    if (!context) return context;
    const scopedRuns = context.runIds
      .map((runId) => this.runtime.repositories.getRun(runId))
      .filter(Boolean);
    context.timeRange = deriveDashboardTimeRange(scopedRuns);
    context.alignedTimeRange =
      scopedRuns.length > 1
        ? alignedRange(scopedRuns.map((run) => timelineFromRun(run!)))
        : undefined;
    if (!this.runtime.dashboardProbe) return context;
    const health = await this.runtime.dashboardProbe(context);
    context.health = { ...health, checkedAt: now() };
    context.availability = !health.grafana
      ? "unavailable"
      : context.runIds.length > 0 &&
          context.runIds.every((id) => health.metricsAvailability?.[id] === "expired")
        ? "expired"
        : health.prometheus && health.labelsValid
          ? "available"
          : "degraded";
    this.runtime.controlRepository.updateDashboardPresentation(context);
    return context;
  }

  private syncExperimentStatus(experimentId: string): string {
    const experiment = this.runtime.repositories.getExperiment(experimentId);
    const stored = this.runtime.controlRepository.getControlExperiment(experimentId);
    const status =
      stored?.status === "BLOCKED" && experiment?.status === "QUEUED"
        ? "BLOCKED"
        : (experiment?.status ?? stored?.status ?? "QUEUED");
    this.runtime.controlRepository.updateControlExperiment(experimentId, { status });
    return status;
  }

  private syncRunStatus(metadata: ControlRunView): ControlRunView {
    const run = this.runtime.repositories.getRun(metadata.id);
    if (!run) return metadata;
    const state =
      metadata.queueState === "BLOCKED" && run.state === "QUEUED"
        ? "BLOCKED"
        : (run.state as ControlRunView["state"]);
    const updated = {
      ...metadata,
      state,
      queueState: state,
      startedAt: run.startedAt,
      databaseRunControlEvidence: run.environmentSnapshot?.databaseRunControlEvidence as
        Record<string, unknown> | undefined,
      updatedAt: now()
    };
    this.runtime.controlRepository.saveRunMetadata({ runId: updated.id, ...updated });
    return updated;
  }

  private isTerminal(state: string): boolean {
    return [
      "SUCCEEDED",
      "INCOMPLETE",
      "THRESHOLD_FAILED",
      "FAILED",
      "CANCELLED",
      "INTERRUPTED"
    ].includes(state);
  }
}
