import { findingEvidence } from "./findings";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { diagnosticLines, inspectProducerFile } from "./producer-files";
import type { Run } from "../../../../packages/contracts/src/run";
import type { Artifact } from "../../../../packages/contracts/src/artifacts";
import {
  DIAGNOSTIC_DEFAULTS,
  FrozenDiagnosticsConfig,
  MeasurementExpectation,
  RunDiagnosticsManifest,
  validateMeasurementEvidence,
  freezeDiagnosticsConfig,
  MeasurementProducerConfig
} from "../../../../packages/contracts/src/measurement-diagnostics";
import { DiagnosticBudgetStore, MeasurementDiagnosticsWriter } from "./writer";
import { validateDiagnosticMetadata } from "./metadata";
import { artifactRecord } from "../artifacts/manifest";
import type { RunDiagnosticsMount } from "../../../../packages/compose-runner/src/run-compose";
import { buildMeasurementInventory, InventoryInput } from "./inventory";
import {
  QueryEvidenceContext,
  currentQueryEvidence
} from "../../../../packages/metrics/src/query-evidence";
import type { ObserverContext } from "../../../../packages/observers/src/adapter";

export interface MeasurementDiagnosticsOptions {
  artifactRoot: string;
  registerArtifact(artifact: Artifact): void;
  listArtifacts(runId: string): Artifact[];
  secrets?: string[];
}
function ownedId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new Error("measurement_diagnostics_invalid:owned_id");
  return value;
}
export async function immutableJson(file: string, value: unknown, ownedRoot: string) {
  const root = await fs.realpath(ownedRoot),
    relative = path.relative(root, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("measurement_diagnostics_invalid:write_owner");
  let current = root;
  for (const part of path.dirname(relative).split(path.sep)) {
    if (part === ".") continue;
    current = path.join(current, part);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(current)) !== current)
      throw new Error("measurement_diagnostics_invalid:write_symlink");
  }
  const body = JSON.stringify(value) + "\n";
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Buffer.byteLength(body);
}
export class MeasurementDiagnosticsService {
  constructor(readonly options: MeasurementDiagnosticsOptions) {}
  async begin(run: Run, options: { audit?: boolean } = {}): Promise<RunMeasurementDiagnostics> {
    ownedId(run.id);
    ownedId(run.experimentId);
    const prior = (run.environmentSnapshot as any)?.measurementDiagnosticsEvidence;
    if (options.audit && prior?.recordingState === "RECORDING")
      throw new Error("measurement_diagnostics_active_attempt");
    if (prior?.attemptId && !options.audit)
      throw new Error("measurement_diagnostics_replay_refused");
    const frozen = (run.environmentSnapshot as any)?.resolvedMeasurementDiagnostics as
      FrozenDiagnosticsConfig | undefined;
    if (!frozen) throw new Error("measurement_diagnostics_budget_not_recorded");
    const config = freezeDiagnosticsConfig(
      { contractVersion: frozen.contractVersion, mode: frozen.mode },
      frozen,
      frozen.frozenAtMs
    );
    if (options.audit && !prior?.attemptId)
      throw new Error("measurement_diagnostics_original_attempt_unavailable");
    const store = options.audit
      ? await DiagnosticBudgetStore.attach(
          path.join(this.options.artifactRoot, run.id, "measurement-diagnostics"),
          run.id,
          prior.runBudgetId,
          config
        )
      : await DiagnosticBudgetStore.open(this.options.artifactRoot, run.id, config);
    const budget = await store.read();
    const summaryRemaining =
      budget.summaryLimitBytes -
      budget.committedSummaryBytes -
      budget.reservations.reduce((n, r) => n + r.summaryBytes, 0);
    const traceRemaining =
      budget.traceLimitBytes -
      budget.committedTraceBytes -
      budget.reservations.reduce((n, r) => n + r.traceBytes, 0);
    if (summaryRemaining < 24576 || (config.mode === "trace" && traceRemaining < 1024))
      throw new Error("measurement_diagnostics_budget_exhausted");
    const attemptId = randomUUID(),
      manifestReservation = `manifest-${attemptId}`;
    await store.reserve({
      reservationId: manifestReservation,
      attemptId,
      producerId: "manifest",
      summaryBytes: Math.min(65536, Math.floor(summaryRemaining / 4)),
      traceBytes: 0
    });
    run.environmentSnapshot = {
      ...run.environmentSnapshot,
      measurementDiagnosticsEvidence: {
        attemptId,
        recordingState: "RECORDING",
        runBudgetId: budget.runBudgetId
      }
    };
    const available = summaryRemaining - Math.min(65536, Math.floor(summaryRemaining / 4));
    const metadataBytes = Math.floor((available * 3) / 4),
      observationBytes = available - metadataBytes;
    const kinds = new Set(
      ((run.environmentSnapshot as any)?.scenario?.observers ?? []).map(
        (observer: any) => observer.kind
      )
    );
    const nativeNames = [
      ["openedge_db_v1", "db-observer"],
      ["openedge_pas_v1", "pas-observer"],
      ["file_sampler_v1", "file-sampler"]
    ]
      .filter(([kind]) => !options.audit && kinds.has(kind))
      .map(([, name]) => name);
    // Native inventory and finalization share one bounded metadata working set.
    // Preserve the combined ceiling while giving that producer its actual share.
    const pending = Math.floor(config.pendingLimitBytes / (nativeNames.length + 9));
    const controllerPending = pending * 3,
      metadataPending = pending * 6;
    const observationShares = nativeNames.length ? nativeNames.length + 3 : 1;
    const controllerSummary = Math.floor(
      (observationBytes * (nativeNames.length ? 3 : 1)) / observationShares
    );
    const controllerTrace =
      config.mode === "trace"
        ? Math.floor((traceRemaining * (nativeNames.length ? 3 : 1)) / observationShares)
        : 0;
    const nativeConfigurations: Record<string, MeasurementProducerConfig> = {};
    for (const component of nativeNames)
      nativeConfigurations[component] = {
        contractVersion: "measurement-diagnostics-producer.v1",
        runId: run.id,
        experimentId: run.experimentId,
        diagnosticAttemptId: attemptId,
        runBudgetId: budget.runBudgetId,
        component,
        config,
        summaryBytes: Math.floor(observationBytes / observationShares),
        traceBytes: config.mode === "trace" ? Math.floor(traceRemaining / observationShares) : 0,
        pendingLimitBytes: pending
      };
    let controller: MeasurementDiagnosticsWriter | undefined,
      metadata: MeasurementDiagnosticsWriter | undefined;
    try {
      controller = await MeasurementDiagnosticsWriter.create(store, {
        runId: run.id,
        experimentId: run.experimentId,
        diagnosticAttemptId: attemptId,
        component: "controller",
        mode: config.mode,
        summaryBytes: controllerSummary,
        traceBytes: controllerTrace,
        pendingLimitBytes: controllerPending,
        eventLimitBytes: config.eventLimitBytes,
        flushIntervalMs: config.flushIntervalMs,
        secrets: this.options.secrets
      });
      metadata = await MeasurementDiagnosticsWriter.create(store, {
        runId: run.id,
        experimentId: run.experimentId,
        diagnosticAttemptId: attemptId,
        component: "metadata",
        mode: "summary",
        summaryBytes: metadataBytes,
        traceBytes: 0,
        pendingLimitBytes: metadataPending,
        eventLimitBytes: config.eventLimitBytes,
        flushIntervalMs: config.flushIntervalMs,
        secrets: this.options.secrets,
        metadataValidator: (input) => {
          const value = validateDiagnosticMetadata(input) as any;
          if (
            (value.runId !== undefined && value.runId !== run.id) ||
            (value.diagnosticAttemptId !== undefined && value.diagnosticAttemptId !== attemptId) ||
            (value.runIds !== undefined && !value.runIds.includes(run.id))
          )
            throw new Error("measurement_metadata_invalid:owner");
          return value;
        }
      });
      controller.record({
        stage: "DIAGNOSTIC_WRITE",
        outcome: "STARTED",
        phase: "pending",
        scheduledAtMs: null,
        startedAtMs: Date.now(),
        finishedAtMs: null,
        sourceCapturedAtMs: null,
        availableAtMs: Date.now(),
        timestampOrigin: "UNKNOWN",
        durationMs: 0,
        queueWaitMs: 0,
        bodyReadMs: 0,
        callerRole: "UNKNOWN",
        reasonCodes: ["producer_started"]
      });
      run.environmentSnapshot = {
        ...run.environmentSnapshot,
        measurementDiagnosticsEvidence: {
          attemptId,
          recordingState: "RECORDING",
          runBudgetId: budget.runBudgetId,
          ...(options.audit ? { parentDiagnosticAttemptId: prior.attemptId } : {})
        }
      };
      return new RunMeasurementDiagnostics(
        this,
        run,
        config,
        store,
        attemptId,
        manifestReservation,
        controller,
        metadata,
        nativeConfigurations,
        {
          controller: {
            summaryBytes: controllerSummary,
            traceBytes: controllerTrace,
            pendingLimitBytes: controllerPending
          },
          metadata: { summaryBytes: metadataBytes, pendingLimitBytes: metadataPending }
        },
        options.audit ? prior.attemptId : undefined
      );
    } catch (error) {
      await controller?.close();
      await metadata?.close();
      await store.settle(manifestReservation, 0, 0, true).catch(() => {});
      throw error;
    }
  }
  /** Explicit startup recovery reads the frozen attempt only. The caller proves
   * owned native processes quiescent; this path never provisions or replays work. */
  async reconcileBudget(run: Run, quiesce: () => Promise<void>) {
    if (
      !new Set([
        "SUCCEEDED",
        "INCOMPLETE",
        "FAILED",
        "CANCELLED",
        "INTERRUPTED",
        "THRESHOLD_FAILED"
      ]).has(run.state) ||
      run.cleanupStatus !== "COMPLETE"
    )
      throw new Error("measurement_diagnostics_recovery_requires_terminal_cleanup");
    const existing = await this.read(run),
      manifest = existing.manifest;
    if (!manifest || manifest.recordingState !== "UNAVAILABLE")
      throw new Error("measurement_diagnostics_recovery_manifest_unavailable");
    const directory = path.join(
        this.options.artifactRoot,
        ownedId(run.id),
        "measurement-diagnostics"
      ),
      store = await DiagnosticBudgetStore.attach(
        directory,
        run.id,
        manifest.runBudgetId,
        manifest.config
      ),
      before = await store.read();
    if (
      before.accountingState === "CONFIRMED" &&
      before.reservations.every((r) => r.reservationId === "retention-control")
    ) {
      await this.registerReconciliationReceipts(run, manifest, before.revision);
      return {
        recordingState: manifest.recordingState,
        accountingState: before.accountingState,
        recovered: false
      };
    }
    await quiesce();
    const reservations = before.reservations.filter((r) => r.reservationId !== "retention-control"),
      receipt = {
        contractVersion: "measurement-budget-reconciliation.v1",
        runId: run.id,
        runBudgetId: before.runBudgetId,
        targetAttemptId: manifest.diagnosticAttemptId,
        beforeRevision: before.revision,
        afterRevision: before.revision + 2,
        policy: "FULL_UNCERTAIN_RESERVATION_CHARGE",
        producerCompleteness: "UNCONFIRMED",
        originalRecordingState: manifest.recordingState,
        chargedSummaryBytes: reservations.reduce((n, r) => n + r.summaryBytes, 0),
        chargedTraceBytes: reservations.reduce((n, r) => n + r.traceBytes, 0),
        reservationCount: reservations.length
      },
      file = path.join(
        directory,
        ownedId(manifest.diagnosticAttemptId),
        "reconciliation",
        `budget-${before.revision}.json`
      ),
      body = JSON.stringify(receipt) + "\n",
      bytes = Buffer.byteLength(body),
      control = before.reservations.find((r) => r.reservationId === "retention-control");
    if (!control || bytes > control.summaryBytes || bytes > 4096)
      throw new Error("measurement_diagnostics_recovery_receipt_budget");
    await store.reconcileUncertainReservations(before.revision, bytes, async () => {
      await immutableJson(file, receipt, directory);
    });
    await this.registerReconciliationReceipts(run, manifest, (await store.read()).revision);
    return {
      recordingState: manifest.recordingState,
      accountingState: "CONFIRMED",
      recovered: true,
      chargedSummaryBytes: receipt.chargedSummaryBytes,
      chargedTraceBytes: receipt.chargedTraceBytes
    };
  }
  private async registerReconciliationReceipts(
    run: Run,
    manifest: RunDiagnosticsManifest,
    revision: number
  ) {
    const directory = path.join(
      this.options.artifactRoot,
      ownedId(run.id),
      "measurement-diagnostics",
      ownedId(manifest.diagnosticAttemptId),
      "reconciliation"
    );
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (names.length > 256) throw new Error("measurement_diagnostics_recovery_receipt_limit");
    for (const name of names) {
      if (!/^budget-[0-9]+\.json$/.test(name))
        throw new Error("measurement_diagnostics_recovery_receipt_invalid");
      const file = path.join(directory, name),
        stat = await fs.lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4096 ||
        (await fs.realpath(file)) !== path.resolve(file)
      )
        throw new Error("measurement_diagnostics_recovery_receipt_invalid");
      const receipt = JSON.parse(await fs.readFile(file, "utf8")),
        keys = [
          "contractVersion",
          "runId",
          "runBudgetId",
          "targetAttemptId",
          "beforeRevision",
          "afterRevision",
          "policy",
          "producerCompleteness",
          "originalRecordingState",
          "chargedSummaryBytes",
          "chargedTraceBytes",
          "reservationCount"
        ];
      if (
        Object.keys(receipt).length !== keys.length ||
        Object.keys(receipt).some((k) => !keys.includes(k)) ||
        receipt.contractVersion !== "measurement-budget-reconciliation.v1" ||
        receipt.runId !== run.id ||
        receipt.runBudgetId !== manifest.runBudgetId ||
        receipt.targetAttemptId !== manifest.diagnosticAttemptId ||
        receipt.policy !== "FULL_UNCERTAIN_RESERVATION_CHARGE" ||
        receipt.producerCompleteness !== "UNCONFIRMED" ||
        receipt.originalRecordingState !== "UNAVAILABLE" ||
        [
          "beforeRevision",
          "afterRevision",
          "chargedSummaryBytes",
          "chargedTraceBytes",
          "reservationCount"
        ].some((k) => !Number.isSafeInteger(receipt[k]) || receipt[k] < 0) ||
        receipt.afterRevision !== receipt.beforeRevision + 2
      )
        throw new Error("measurement_diagnostics_recovery_receipt_invalid");
      if (receipt.afterRevision > revision) continue; // Interrupted recovery stays unconfirmed.
      const relative = path.relative(await fs.realpath(this.options.artifactRoot), file);
      if (!this.options.listArtifacts(run.id).some((a) => a.path === relative))
        this.options.registerArtifact(
          artifactRecord(run.id, "diagnostics", { path: relative, sizeBytes: stat.size }, "json", {
            contractVersion: "measurement-diagnostics.v1",
            attemptId: manifest.diagnosticAttemptId,
            role: "budget-reconciliation"
          })
        );
    }
  }
  async recover(
    run: Run,
    quiesce: () => Promise<void>
  ): Promise<{ recordingState: string; manifest?: RunDiagnosticsManifest }> {
    const existing = await this.read(run);
    if (existing.manifest) return existing;
    const evidence = (run.environmentSnapshot as any)?.measurementDiagnosticsEvidence;
    const config = (run.environmentSnapshot as any)
      ?.resolvedMeasurementDiagnostics as FrozenDiagnosticsConfig;
    if (!evidence?.attemptId || !config) return existing;
    ownedId(run.id);
    ownedId(evidence.attemptId);
    const directory = path.join(this.options.artifactRoot, run.id, "measurement-diagnostics");
    const store = await DiagnosticBudgetStore.attach(
      directory,
      run.id,
      evidence.runBudgetId,
      config
    );
    let quiescent = false;
    try {
      await quiesce();
      quiescent = true;
    } catch {
      /* Unknown native state remains unavailable. */
    }
    const before = await store.read(),
      attemptId = evidence.attemptId;
    const producers: any[] = [],
      artifacts: Artifact[] = [];
    let incomplete = !quiescent;
    const files = path.join(directory, attemptId, "summary");
    let names: string[] = [];
    try {
      names = await fs.readdir(files);
    } catch {
      incomplete = true;
    }
    for (const name of names) {
      const match = name.match(
        /^(controller|metadata|db-observer|pas-observer|file-sampler)-([a-f0-9-]{36})\.jsonl$/
      );
      if (!match) {
        incomplete = true;
        continue;
      }
      const [, component, instanceId] = match,
        file = path.join(files, name);
      try {
        const result = await inspectProducerFile(
          file,
          { runId: run.id, attemptId, component, instanceId },
          "summary",
          config.summaryLimitBytes
        );
        if (!quiescent || !result.terminal) {
          incomplete = true;
          continue;
        }
        const p = result.terminal;
        producers.push({
          component,
          componentInstanceId: instanceId,
          reservationId: p.reservationId,
          summaryBytes: p.summaryBytes,
          traceBytes: p.traceBytes,
          sequenceStart: p.sequenceStart,
          sequenceEnd: p.sequenceEnd,
          attemptedEvents: p.attemptedEvents,
          retainedEvents: p.retainedEvents,
          droppedEvents: p.droppedEvents,
          writeFailures: p.writeFailures,
          flushState: p.flushState,
          budgetAccountingState: p.budgetAccountingState,
          collectionStatus: "COMPLETE",
          acceptedEvents: p.acceptedEvents,
          unconfirmedEvents: p.unconfirmedEvents,
          lostSequenceRanges: p.lostSequenceRanges,
          lostSequenceRangesIncomplete: p.lostSequenceRangesIncomplete,
          droppedMetadataRecords: p.droppedMetadataRecords
        });
        const relative = path.relative(
          await fs.realpath(this.options.artifactRoot),
          await fs.realpath(file)
        );
        const prior = this.options.listArtifacts(run.id).find((a) => a.path === relative);
        if (
          prior &&
          (prior.runId !== run.id ||
            prior.kind !== "diagnostics" ||
            prior.sourceMetadata?.attemptId !== attemptId ||
            prior.sourceMetadata?.role !== "producer-summary")
        )
          throw new Error("measurement_recovery_receipt_owner");
        const artifact =
          prior ??
          artifactRecord(
            run.id,
            "diagnostics",
            { path: relative, sizeBytes: result.bytes },
            "jsonl",
            {
              contractVersion: "measurement-diagnostics.v1",
              runId: run.id,
              attemptId,
              role: "producer-summary"
            }
          );
        if (!prior) this.options.registerArtifact(artifact);
        artifacts.push(artifact);
      } catch {
        incomplete = true;
      }
    }
    for (const reservation of before.reservations.filter(
      (r) => r.attemptId === attemptId && !["manifest", "retention"].includes(r.producerId)
    )) {
      if (producers.some((p) => p.reservationId === reservation.reservationId)) continue;
      incomplete = true;
      producers.push({
        component: reservation.producerId,
        componentInstanceId: `interrupted-${producers.length}`,
        reservationId: reservation.reservationId,
        summaryBytes: 0,
        traceBytes: 0,
        sequenceStart: 0,
        sequenceEnd: 0,
        attemptedEvents: 0,
        retainedEvents: 0,
        droppedEvents: 0,
        writeFailures: 0,
        flushState: "UNCONFIRMED",
        budgetAccountingState: "UNCONFIRMED",
        collectionStatus: "PARTIAL",
        lostSequenceRangesIncomplete: true
      });
    }
    if (incomplete) await store.markUnconfirmed();
    const budget = await store.read(),
      reservationId = `manifest-${attemptId}`;
    if (!budget.reservations.some((r) => r.reservationId === reservationId))
      return { recordingState: "UNAVAILABLE" };
    const result = await store.sealSnapshot(reservationId, (snapshot) =>
      validateMeasurementEvidence<RunDiagnosticsManifest>({
        contractVersion: "measurement-diagnostics.v1",
        runId: run.id,
        experimentId: run.experimentId,
        diagnosticAttemptId: attemptId,
        config,
        createdAtMs: config.frozenAtMs,
        finalizedAtMs: Date.now(),
        recordingState: snapshot.accountingState === "UNCONFIRMED" ? "UNAVAILABLE" : "INTERRUPTED",
        deployedRefs: {},
        phaseRefs: Object.keys(run.phaseBoundaries ?? {}),
        cadenceRefs: [],
        producers,
        inventoryPages: [],
        findingPages: [],
        queryRefs: [],
        artifactIndex: artifacts.map((a) => ({
          artifactId: a.id,
          role: "producer-summary",
          path: a.path,
          sizeBytes: a.sizeBytes
        })),
        stageAggregates: [],
        summaryBytes: snapshot.committedSummaryBytes,
        traceBytes: snapshot.committedTraceBytes,
        droppedEvents: producers.reduce((n, p) => n + p.droppedEvents, 0),
        writeFailures: producers.reduce((n, p) => n + p.writeFailures, 0),
        inventoryIncomplete: true,
        findingsIncomplete: true,
        runBudgetId: snapshot.runBudgetId,
        budgetSnapshot: snapshot
      })
    );
    const manifest = result.payload as RunDiagnosticsManifest,
      file = path.join(directory, attemptId, "manifest.json");
    await immutableJson(file, manifest, directory);
    const artifact = artifactRecord(
      run.id,
      "diagnostics",
      {
        path: path.relative(this.options.artifactRoot, file),
        sizeBytes: (await fs.stat(file)).size
      },
      "json",
      { contractVersion: "measurement-diagnostics.v1", runId: run.id, attemptId, role: "manifest" }
    );
    this.options.registerArtifact(artifact);
    run.environmentSnapshot = {
      ...run.environmentSnapshot,
      measurementDiagnosticsEvidence: {
        ...evidence,
        recordingState: manifest.recordingState,
        manifestArtifactId: artifact.id
      }
    };
    return { recordingState: manifest.recordingState, manifest };
  }
  async read(run: Run): Promise<{ recordingState: string; manifest?: RunDiagnosticsManifest }> {
    ownedId(run.id);
    const evidence = (run.environmentSnapshot as any)?.measurementDiagnosticsEvidence;
    if (!evidence?.attemptId) return { recordingState: evidence ? "UNAVAILABLE" : "NOT_RECORDED" };
    try {
      ownedId(evidence.attemptId);
    } catch {
      return { recordingState: "UNAVAILABLE" };
    }
    const file = path.join(
      this.options.artifactRoot,
      run.id,
      "measurement-diagnostics",
      evidence.attemptId,
      "manifest.json"
    );
    const relative = path.join(
      run.id,
      "measurement-diagnostics",
      evidence.attemptId,
      "manifest.json"
    );
    const receipt = this.options
      .listArtifacts(run.id)
      .find(
        (a) =>
          a.runId === run.id &&
          a.kind === "diagnostics" &&
          a.path === relative &&
          a.sourceMetadata?.role === "manifest" &&
          a.sourceMetadata?.attemptId === evidence.attemptId
      );
    if (!receipt) return { recordingState: "UNAVAILABLE" };
    try {
      const root = await fs.realpath(this.options.artifactRoot);
      if (
        (await fs.realpath(file)) !==
        path.join(root, run.id, "measurement-diagnostics", evidence.attemptId, "manifest.json")
      )
        return { recordingState: "UNAVAILABLE" };
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144)
        return { recordingState: "UNAVAILABLE" };
      const manifest = validateMeasurementEvidence<RunDiagnosticsManifest>(
        JSON.parse(await fs.readFile(file, "utf8"))
      );
      if (manifest.runId !== run.id || manifest.diagnosticAttemptId !== evidence.attemptId)
        return { recordingState: "UNAVAILABLE" };
      return { recordingState: manifest.recordingState, manifest };
    } catch {
      return { recordingState: "UNAVAILABLE" };
    }
  }
}
export class RunMeasurementDiagnostics {
  private expectationsComplete = false;
  private startupInventory?: {
    dimensions: Record<string, string[]>;
    availability: Array<{
      metricName: string;
      dimensions: Record<string, string>;
      availability: string;
      reasonCode: string;
      sourceRef: string;
    }>;
    evidenceId: string;
  };
  private inventoryRelease?: () => void;
  private inventoryJobs: Promise<void> = Promise.resolve();
  private pathInventory = new Map<string, any>();
  private topology: NonNullable<InventoryInput["topology"]> = [];
  readonly deployedRefs: Record<string, string> = {};
  private captureInventory(input: any) {
    if (input?.contractVersion === "measurement-path-inventory.v1") {
      const priorPath = this.pathInventory.get(input.observerId);
      if (priorPath && (priorPath.kind !== input.kind || priorPath.pathRef !== input.pathRef)) {
        this.recordMetadata(input);
        this.metadataIncomplete = true;
        this.pathInventory.set(input.observerId, { ...priorPath, kind: "unknown" });
      }
      if (!this.pathInventory.has(input.observerId)) {
        this.recordMetadata(input);
        this.pathInventory.set(input.observerId, validateDiagnosticMetadata(input));
      }
      return;
    }
    if (
      input?.contractVersion !== "measurement-native-inventory.v1" ||
      this.startupInventory ||
      input.runId !== this.run.id ||
      !Array.isArray(input.availability) ||
      !input.dimensions ||
      typeof input.evidenceId !== "string"
    ) {
      this.metadataIncomplete = true;
      return;
    }
    const body = JSON.stringify(input),
      release = this.metadata.reserveWorkingMemory(Buffer.byteLength(body));
    if (!release) {
      this.metadataIncomplete = true;
      return;
    }
    this.inventoryRelease = release;
    this.startupInventory = input;
    this.inventoryJobs = this.inventoryJobs
      .then(async () => {
        this.recordMetadata({
          contractVersion: "measurement-native-inventory-header.v1",
          runId: this.run.id,
          evidenceId: input.evidenceId,
          capturedAtMs: input.capturedAtMs,
          availabilityCount: input.availability.length
        });
        for (const [dimension, identities] of Object.entries(input.dimensions) as Array<
          [string, string[]]
        >) {
          for (let i = 0; i < identities.length; i += 16) {
            await this.metadata.flush();
            this.recordMetadata({
              contractVersion: "measurement-native-dimension.v1",
              evidenceId: input.evidenceId,
              dimension,
              identities: identities.slice(i, i + 16)
            });
          }
        }
        for (const availability of input.availability) {
          await this.metadata.flush();
          this.recordMetadata({
            contractVersion: "measurement-native-availability.v1",
            evidenceId: input.evidenceId,
            ...availability
          });
        }
        await this.metadata.flush();
      })
      .catch(() => {
        this.metadataIncomplete = true;
      });
  }
  markIncomplete() {
    this.metadataIncomplete = true;
  }
  setTopology(
    members: Array<NonNullable<InventoryInput["topology"]>[number] & { imageId: string }>
  ) {
    this.topology = members.map(({ imageId, ...member }) => member);
    for (const member of members) {
      this.deployedRefs[`${member.group}:${member.service}:${member.memberId}`] = member.imageId;
      if (this.deployedRefs[member.service] && this.deployedRefs[member.service] !== member.imageId)
        this.metadataIncomplete = true;
      else this.deployedRefs[member.service] = member.imageId;
    }
    const capturedAtMs = Date.now();
    for (let offset = 0; offset < members.length; offset += 8)
      this.recordMetadata({
        contractVersion: "measurement-topology.v1",
        runId: this.run.id,
        capturedAtMs,
        members: members.slice(offset, offset + 8)
      });
  }
  async flushStartupInventory() {
    await this.inventoryJobs;
    await this.metadata.flush();
  }
  async prepareInventory(
    window: { startMs: number; endMs: number },
    cadences: { controllerCadenceMs: number; scrapeCadenceMs: number }
  ) {
    await this.inventoryJobs;
    const native = this.startupInventory,
      identities: Record<string, Array<Record<string, string>>> = {};
    for (const item of native?.availability ?? [])
      (identities[item.metricName.replace(/^parkbench_openedge_db_/, "")] ??= []).push(
        item.dimensions
      );
    const inventory = buildMeasurementInventory({
      runId: this.run.id,
      phase: "measurement",
      ...window,
      ...cadences,
      sourceCadenceMs: null,
      topology: this.topology,
      nativeDimensions: native?.dimensions,
      nativeAvailability: native?.availability,
      nativeEvidenceRef: native?.evidenceId,
      nativeIdentities: identities,
      tables: native?.dimensions.table,
      paths: [...this.pathInventory.values()].map((p) => ({
        file: p.pathRef,
        kind: ["file", "directory"].includes(p.kind) ? p.kind : "unknown",
        evidenceRef: `${p.observerId}:${p.capturedAtMs}`
      }))
    });
    if (inventory.inventoryIncomplete) {
      this.metadataIncomplete = true;
      for (let page = 0; page * 16 < inventory.missingInventoryKinds.length; page++)
        this.recordMetadata({
          contractVersion: "measurement-inventory-status.v1",
          runId: this.run.id,
          diagnosticAttemptId: this.attemptId,
          inventoryIncomplete: true,
          page,
          totalPages: Math.ceil(inventory.missingInventoryKinds.length / 16),
          missingInventoryKinds: inventory.missingInventoryKinds.slice(page * 16, page * 16 + 16)
        });
    }
    try {
      await this.setExpectations(inventory.expectations);
      if (inventory.inventoryIncomplete) this.expectationsComplete = false;
    } finally {
      this.startupInventory = undefined;
      this.inventoryRelease?.();
      this.inventoryRelease = undefined;
    }
  }
  queryContext(startMs: number, endMs: number): QueryEvidenceContext {
    return {
      runId: this.run.id,
      runIds: [this.run.id],
      diagnosticAttemptId: this.attemptId,
      consumer: this.parentDiagnosticAttemptId ? "AUDIT" : "FINALIZATION",
      source: "unknown",
      definitionId: "unknown",
      semanticVersion: "unknown",
      dimensions: {},
      expectedMemberIds: [],
      expectationRefs: [],
      requestedStartMs: startMs,
      requestedEndMs: endMs,
      nativeCadenceMs: null,
      scrapeCadenceMs: null,
      lookbackMs: null,
      transforms: [],
      counterEdgePolicy: null,
      resolveExpectedMembers: (source, group) =>
        ["cadvisor", "parkbench-run-owned-cadvisor", "parkbench-run-platform-cadvisor"].includes(
          source
        )
          ? this.topology.filter((m) => m.group === group).map((m) => m.memberId)
          : [],
      reportLoss: () => this.markIncomplete(),
      flush: async () => {
        if (this.metadata.snapshot().pendingBytes > this.config.eventLimitBytes * 2)
          await this.metadata.flush();
      },
      record: (evidence) => this.recordMetadata(evidence),
      recordChunk: (evidence) => {
        const context = currentQueryEvidence();
        this.recordMetadata({
          contractVersion: "measurement-query-chunk.v1",
          runId: this.run.id,
          diagnosticAttemptId: this.attemptId,
          definitionId: context?.definitionId ?? "unknown",
          dimensions: context?.dimensions ?? {},
          source: context?.source ?? "unknown",
          ...evidence
        });
      },
      registerSelector: (selector) => {
        const selectorId = randomUUID();
        this.recordMetadata({ ...selector, selectorId });
        return selectorId;
      },
      recordProjection: (evidence) => this.recordMetadata(evidence),
      recordStatistics: (evidence) => this.recordMetadata(evidence),
      recordCache: (evidence) =>
        this.recordMetadata({ contractVersion: "measurement-publication.v1", ...evidence })
    };
  }

  private metadataIncomplete = false;
  private sealPromise?: Promise<{ manifest: RunDiagnosticsManifest; artifact: Artifact }>;
  private readonly createdAtMs = Date.now();
  constructor(
    private service: MeasurementDiagnosticsService,
    readonly run: Run,
    readonly config: FrozenDiagnosticsConfig,
    readonly store: DiagnosticBudgetStore,
    readonly attemptId: string,
    private manifestReservation: string,
    readonly controller: MeasurementDiagnosticsWriter,
    readonly metadata: MeasurementDiagnosticsWriter,
    readonly nativeConfigurations: Record<string, MeasurementProducerConfig>,
    readonly allocations?: {
      controller: { summaryBytes: number; traceBytes: number; pendingLimitBytes: number };
      metadata: { summaryBytes: number; pendingLimitBytes: number };
    },
    readonly parentDiagnosticAttemptId?: string
  ) {}
  get nativeMount(): RunDiagnosticsMount | undefined {
    const budgetId = Object.values(this.nativeConfigurations)[0]?.runBudgetId;
    if (!budgetId) return undefined;
    const base = {
      contractVersion: "measurement-diagnostics-producer.v1" as const,
      runId: this.run.id,
      experimentId: this.run.experimentId,
      diagnosticAttemptId: this.attemptId,
      runBudgetId: budgetId,
      config: this.config
    };
    const controllerAllocation = this.allocations?.controller,
      metadataAllocation = this.allocations?.metadata;
    return {
      directory: this.store.directory,
      producers: {
        ...this.nativeConfigurations,
        controller: {
          ...base,
          component: "controller",
          summaryBytes: controllerAllocation?.summaryBytes ?? 2048,
          traceBytes: controllerAllocation?.traceBytes ?? 0,
          pendingLimitBytes: controllerAllocation?.pendingLimitBytes ?? 0
        },
        metadata: {
          ...base,
          component: "metadata",
          summaryBytes: metadataAllocation?.summaryBytes ?? 2048,
          traceBytes: 0,
          pendingLimitBytes: metadataAllocation?.pendingLimitBytes ?? 0
        }
      }
    };
  }
  context(phase: string): ObserverContext {
    return {
      runId: this.run.id,
      experimentId: this.run.experimentId,
      variantId: this.run.variantId,
      repetition: this.run.repetition,
      phase,
      measurementEvidence: {
        diagnosticAttemptId: this.attemptId,
        record: (event) => this.controller.record(event),
        recordInventory: (inventory) => this.captureInventory(inventory)
      }
    };
  }
  recordMetadata(record: unknown) {
    if (!this.metadata.recordStructured(record)) this.metadataIncomplete = true;
  }
  async setExpectations(expectations: Iterable<MeasurementExpectation | unknown>) {
    await this.metadata.flush();
    let count = 0,
      failed = false;
    for (const input of expectations) {
      if (this.metadata.snapshot().pendingBytes > this.config.eventLimitBytes * 2)
        await this.metadata.flush();
      const expectation = validateMeasurementEvidence<MeasurementExpectation>(input);
      if (!this.metadata.recordStructured(expectation)) {
        this.metadataIncomplete = true;
        failed = true;
      }
      count++;
    }
    await this.metadata.flush();
    this.expectationsComplete = count > 0 && !failed;
  }
  private async writeFindings() {
    await this.metadata.flush();
    const file = path.join(
      this.store.directory,
      this.attemptId,
      "summary",
      `metadata-${this.metadata.componentInstanceId}.jsonl`
    );
    const index = await findingEvidence(
      file,
      this.metadata,
      this.topology,
      this.pathInventory.size === 1
    );
    if (index.incomplete) this.metadataIncomplete = true;
    const lineBuffer = this.metadata.reserveWorkingMemory(8192);
    if (!lineBuffer) {
      index.release();
      this.metadataIncomplete = true;
      return;
    }
    try {
      for await (const line of diagnosticLines(file)) {
        const envelope = JSON.parse(line);
        if (
          envelope.contractVersion !== "measurement-evidence-record.v1" ||
          envelope.record?.contractVersion !== "measurement-expectation.v1"
        )
          continue;
        if (this.metadata.snapshot().pendingBytes > this.config.eventLimitBytes * 2)
          await this.metadata.flush();
        const finding = index.finding(
          validateMeasurementEvidence<MeasurementExpectation>(envelope.record)
        );
        if (finding && !this.metadata.recordStructured(validateMeasurementEvidence(finding)))
          this.metadataIncomplete = true;
      }
      await this.metadata.flush();
    } catch {
      this.metadataIncomplete = true;
    } finally {
      lineBuffer();
      index.release();
    }
  }
  seal(options: {
    terminalState: string;
    phaseRefs: string[];
    deployedRefs: Record<string, string>;
    nativeQuiescence?: boolean;
  }) {
    this.sealPromise ??= this.finish(options);
    return this.sealPromise;
  }
  private async register(file: string, role: string, format = "json"): Promise<Artifact> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("measurement_diagnostics_invalid:artifact_file");
    const root = await fs.realpath(this.service.options.artifactRoot),
      actual = await fs.realpath(file);
    if (
      !actual.startsWith(
        path.join(root, this.run.id, "measurement-diagnostics", this.attemptId) + path.sep
      )
    )
      throw new Error("measurement_diagnostics_invalid:artifact_owner");
    const relative = path.relative(root, actual);
    const existing = this.service.options
      .listArtifacts(this.run.id)
      .find((a) => a.path === relative);
    if (existing) {
      if (
        existing.runId !== this.run.id ||
        existing.kind !== "diagnostics" ||
        existing.sourceMetadata?.attemptId !== this.attemptId ||
        existing.sourceMetadata?.role !== role
      )
        throw new Error("measurement_diagnostics_invalid:artifact_receipt_owner");
      return existing;
    }
    const artifact = artifactRecord(
      this.run.id,
      "diagnostics",
      { path: relative, sizeBytes: stat.size },
      format,
      {
        contractVersion: "measurement-diagnostics.v1",
        runId: this.run.id,
        attemptId: this.attemptId,
        role
      }
    );
    this.service.options.registerArtifact(artifact);
    return artifact;
  }
  private async finish(options: {
    terminalState: string;
    phaseRefs: string[];
    deployedRefs: Record<string, string>;
    nativeQuiescence?: boolean;
  }) {
    await this.inventoryJobs;
    this.inventoryRelease?.();
    this.inventoryRelease = undefined;
    this.startupInventory = undefined;
    await this.writeFindings();
    const controller = await this.controller.close(),
      metadata = await this.metadata.close();
    const directory = path.join(this.store.directory, this.attemptId),
      artifacts: Artifact[] = [];
    const inventoryPages: string[] = [],
      findingPages: string[] = [],
      queryRefs: string[] = [];
    // Metadata is streamed into bounded pages. The logical records are charged once;
    // consolidation adds only its framing delta, never a second source-data archive.
    const metadataFile = path.join(
      directory,
      "summary",
      `metadata-${metadata.componentInstanceId}.jsonl`
    );
    const roles = new Map<string, any[]>();
    let page = 0,
      framingBytes = 0;
    const flush = async (role: string) => {
      const records = roles.get(role) ?? [];
      if (!records.length) return;
      const file = path.join(directory, role, `${String(page++).padStart(5, "0")}.json`);
      await immutableJson(file, records, this.store.directory);
      framingBytes += 2;
      const artifact = await this.register(file, role);
      artifacts.push(artifact);
      (role === "inventory" ? inventoryPages : role === "findings" ? findingPages : queryRefs).push(
        artifact.id
      );
      roles.set(role, []);
    };
    let metadataFileValid = true;
    try {
      const inspected = await inspectProducerFile(
        metadataFile,
        {
          runId: this.run.id,
          attemptId: this.attemptId,
          component: "metadata",
          instanceId: metadata.componentInstanceId
        },
        "summary",
        this.config.summaryLimitBytes
      );
      if (!inspected.terminal) throw new Error("measurement_metadata_terminal_missing");
    } catch {
      metadataFileValid = false;
      this.metadataIncomplete = true;
      await this.store.markUnconfirmed();
    }
    if (metadataFileValid) {
      const lines = diagnosticLines(metadataFile);
      for await (const line of lines) {
        if (Buffer.byteLength(line) > 4096) {
          this.metadataIncomplete = true;
          continue;
        }
        const envelope = JSON.parse(line);
        if (envelope.contractVersion !== "measurement-evidence-record.v1") continue;
        const version = envelope.record?.contractVersion ?? "";
        const role =
          version === "measurement-expectation.v1" ||
          version.includes("inventory") ||
          version.includes("availability") ||
          version.includes("dimension")
            ? "inventory"
            : version === "measurement-finding.v1"
              ? "findings"
              : "queries";
        const records = roles.get(role) ?? [];
        if (Buffer.byteLength(JSON.stringify(records)) + Buffer.byteLength(line) > 65500)
          await flush(role);
        const current = roles.get(role) ?? [];
        current.push(envelope);
        roles.set(role, current);
      }
    }
    for (const role of roles.keys()) await flush(role);
    // Validate every downloadable producer record with bounded reads. Only terminal
    // records prove a producer stopped writing; absent/partial producers stay explicit.
    const nativeProducers: any[] = [];
    let producerUnavailable = !metadataFileValid;
    const validNativeTraces = new Set<string>();
    const collected = new Map<string, any>();
    for (const kind of ["summary", "trace"] as const) {
      let names: string[] = [];
      try {
        names = await fs.readdir(path.join(directory, kind));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const name of names) {
        const match = name.match(
          /^(controller|metadata|db-observer|pas-observer|file-sampler)-([a-f0-9-]{36})\.jsonl$/
        );
        if (!match) {
          producerUnavailable = true;
          continue;
        }
        const [, component, instanceId] = match;
        const native = this.nativeConfigurations[component];
        if (!["controller", "metadata"].includes(component) && !native) {
          producerUnavailable = true;
          continue;
        }
        if (native && options.nativeQuiescence === false) {
          producerUnavailable = true;
          continue;
        }
        const file = path.join(directory, kind, name);
        try {
          const result = await inspectProducerFile(
            file,
            { runId: this.run.id, attemptId: this.attemptId, component, instanceId },
            kind,
            kind === "summary"
              ? (native?.summaryBytes ?? this.config.summaryLimitBytes)
              : (native?.traceBytes ?? this.config.traceLimitBytes)
          );
          if (kind === "summary" && !result.terminal) {
            producerUnavailable = true;
            continue;
          }
          if (native && kind === "summary") {
            if (!result.terminal) {
              producerUnavailable = true;
              continue;
            }
            collected.set(instanceId, result.terminal);
          }
          if (native && kind === "trace") {
            const terminal = collected.get(instanceId);
            if (!terminal || terminal.traceBytes !== result.bytes) {
              producerUnavailable = true;
              continue;
            }
          }
          if (native && kind === "trace") validNativeTraces.add(instanceId);
          if (component === "metadata" && kind === "summary") await fs.unlink(file);
          else
            artifacts.push(
              await this.register(file, kind === "summary" ? "producer-summary" : "trace", "jsonl")
            );
        } catch {
          producerUnavailable = true;
        }
      }
    }
    for (const component of Object.keys(this.nativeConfigurations)) {
      const terminals = [...collected.values()].filter((p) => p.component === component);
      if (!terminals.length) {
        producerUnavailable = true;
        nativeProducers.push({
          component,
          componentInstanceId: `missing-${component}`,
          reservationId: `missing-${component}`,
          summaryBytes: 0,
          traceBytes: 0,
          sequenceStart: 0,
          sequenceEnd: 0,
          attemptedEvents: 0,
          retainedEvents: 0,
          droppedEvents: 0,
          writeFailures: 0,
          flushState: "UNCONFIRMED",
          budgetAccountingState: "UNCONFIRMED",
          collectionStatus: "MISSING"
        });
      } else {
        for (const producer of terminals)
          if (producer.traceBytes > 0 && !validNativeTraces.has(producer.componentInstanceId)) {
            producerUnavailable = true;
            producer.collectionStatus = "PARTIAL";
          }
        nativeProducers.push(
          ...terminals.map((p) => ({
            ...p,
            collectionStatus:
              p.collectionStatus ?? (p.flushState === "COMPLETE" ? "COMPLETE" : "PARTIAL")
          }))
        );
      }
    }
    let budget = await this.store.read();
    if (
      budget.reservations.some(
        (reservation) =>
          reservation.attemptId === this.attemptId &&
          reservation.reservationId !== this.manifestReservation
      )
    ) {
      await this.store.markUnconfirmed();
      budget = await this.store.read();
    }
    const unavailable =
      producerUnavailable ||
      nativeProducers.some((p) => p.recordingState === "UNAVAILABLE") ||
      controller.recordingState === "UNAVAILABLE" ||
      metadata.recordingState === "UNAVAILABLE" ||
      budget.accountingState === "UNCONFIRMED";
    const truncated =
      nativeProducers.some((p) => p.recordingState === "TRUNCATED") ||
      this.metadataIncomplete ||
      !this.expectationsComplete ||
      controller.recordingState === "TRUNCATED" ||
      metadata.recordingState === "TRUNCATED";
    const producers = [controller, metadata, ...nativeProducers].map((p) => ({
      component: p.component,
      componentInstanceId: p.componentInstanceId,
      reservationId: p.reservationId,
      summaryBytes: p.summaryBytes,
      traceBytes: p.traceBytes,
      sequenceStart: p.sequenceStart,
      sequenceEnd: p.sequenceEnd,
      attemptedEvents: p.attemptedEvents,
      retainedEvents: p.retainedEvents,
      droppedEvents: p.droppedEvents,
      writeFailures: p.writeFailures,
      flushState: p.flushState,
      budgetAccountingState: p.budgetAccountingState,
      collectionStatus: p.collectionStatus ?? "COMPLETE",
      acceptedEvents: p.acceptedEvents ?? 0,
      unconfirmedEvents: p.unconfirmedEvents ?? 0,
      lostSequenceRanges: p.lostSequenceRanges ?? [],
      lostSequenceRangesIncomplete: p.lostSequenceRangesIncomplete ?? false,
      droppedMetadataRecords: p.droppedMetadataRecords ?? 0
    }));
    const manifest: RunDiagnosticsManifest = validateMeasurementEvidence({
      contractVersion: "measurement-diagnostics.v1",
      runId: this.run.id,
      experimentId: this.run.experimentId,
      diagnosticAttemptId: this.attemptId,
      ...(this.parentDiagnosticAttemptId
        ? { parentDiagnosticAttemptId: this.parentDiagnosticAttemptId }
        : {}),
      config: this.config,
      createdAtMs: this.createdAtMs,
      finalizedAtMs: Date.now(),
      recordingState: unavailable
        ? "UNAVAILABLE"
        : truncated
          ? "TRUNCATED"
          : options.terminalState === "INTERRUPTED"
            ? "INTERRUPTED"
            : "SEALED",
      deployedRefs: options.deployedRefs,
      phaseRefs: options.phaseRefs,
      cadenceRefs: [],
      producers,
      inventoryPages,
      findingPages,
      queryRefs,
      artifactIndex: artifacts.map((a) => ({
        artifactId: a.id,
        role: String(a.sourceMetadata?.role),
        path: a.path,
        sizeBytes: a.sizeBytes
      })),
      stageAggregates: controller.aggregates,
      summaryBytes: budget.committedSummaryBytes,
      traceBytes: budget.committedTraceBytes,
      droppedEvents: producers.reduce((n, p) => n + p.droppedEvents, 0),
      writeFailures: producers.reduce((n, p) => n + p.writeFailures, 0),
      inventoryIncomplete: !this.expectationsComplete,
      findingsIncomplete: this.metadataIncomplete,
      runBudgetId: budget.runBudgetId,
      budgetSnapshot: budget
    });
    const manifestFile = path.join(directory, "manifest.json");
    const sealed = await this.store.sealSnapshot(
      this.manifestReservation,
      (snapshot) =>
        validateMeasurementEvidence<RunDiagnosticsManifest>({
          ...manifest,
          summaryBytes: snapshot.committedSummaryBytes,
          traceBytes: snapshot.committedTraceBytes,
          budgetSnapshot: snapshot
        }),
      framingBytes
    );
    const finalManifest = sealed.payload as RunDiagnosticsManifest;
    await immutableJson(manifestFile, finalManifest, this.store.directory);
    const artifact = await this.register(manifestFile, "manifest");
    (this.run.environmentSnapshot as any).measurementDiagnosticsEvidence = {
      attemptId: this.attemptId,
      recordingState: finalManifest.recordingState,
      manifestArtifactId: artifact.id,
      runBudgetId: budget.runBudgetId
    };
    return { manifest: finalManifest, artifact };
  }
}
