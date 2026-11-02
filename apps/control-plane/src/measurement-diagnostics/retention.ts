import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Artifact } from "../../../../packages/contracts/src/artifacts";
import type { Run } from "../../../../packages/contracts/src/run";
import {
  DIAGNOSTIC_DEFAULTS,
  FrozenDiagnosticsConfig,
  RetentionEvent,
  projectDetailAvailability,
  validateMeasurementEvidence
} from "../../../../packages/contracts/src/measurement-diagnostics";
import { DiagnosticBudgetStore } from "./writer";
import { artifactRecord } from "../artifacts/manifest";
import { immutableJson } from "./evidence";
interface RetentionOptions {
  allDiagnosticRuns?(): Run[];
  artifactRoot: string;
  run(id: string): Run | undefined;
  listArtifacts(runId: string): Artifact[];
  allTraceArtifacts(): Artifact[];
  registerArtifact(artifact: Artifact): void;
  isIdle(): boolean;
}
const id = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new Error("measurement_retention_owner_invalid");
  return value;
};
export class MeasurementTraceRetention {
  constructor(readonly options: RetentionOptions) {}
  private async owned(target: Artifact) {
    id(target.runId);
    const attempt = id(String(target.sourceMetadata?.attemptId));
    if (
      target.kind !== "diagnostics" ||
      target.sourceMetadata?.contractVersion !== "measurement-diagnostics.v1" ||
      target.sourceMetadata?.role !== "trace" ||
      !this.options
        .listArtifacts(target.runId)
        .some(
          (a) =>
            a.id === target.id &&
            a.path === target.path &&
            a.sourceMetadata?.attemptId === attempt &&
            a.sourceMetadata?.role === "trace"
        )
    )
      throw new Error("measurement_retention_trace_owner_invalid");
    const root = await fs.realpath(this.options.artifactRoot),
      owned = path.join(root, target.runId, "measurement-diagnostics"),
      file = path.resolve(root, target.path);
    if (!file.startsWith(path.join(owned, attempt, "trace") + path.sep))
      throw new Error("measurement_retention_path_invalid");
    return { owned, file, attempt };
  }
  async events(runId: string): Promise<RetentionEvent[]> {
    id(runId);
    const root = await fs.realpath(this.options.artifactRoot),
      directory = path.join(root, runId, "measurement-diagnostics", "retention");
    let names: string[];
    try {
      if ((await fs.realpath(directory)) !== directory)
        throw new Error("measurement_retention_symlink");
      names = await fs.readdir(directory);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        !this.options.listArtifacts(runId).some((a) => a.sourceMetadata?.role === "retention-event")
      )
        return [];
      throw error;
    }
    if (
      names.length !==
      this.options.listArtifacts(runId).filter((a) => a.sourceMetadata?.role === "retention-event")
        .length
    )
      throw new Error("measurement_retention_receipt_unavailable");
    if (names.length > 256) throw new Error("measurement_retention_journal_unavailable");
    const events: RetentionEvent[] = [];
    let bytes = 0;
    for (const name of names.sort()) {
      if (!/^\d{8}-[a-f0-9-]{36}\.json$/.test(name))
        throw new Error("measurement_retention_journal_unavailable");
      const file = path.join(directory, name),
        stat = await fs.lstat(file);
      bytes += stat.size;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || bytes > 65536)
        throw new Error("measurement_retention_journal_unavailable");
      const event = validateMeasurementEvidence<RetentionEvent>(
        JSON.parse(await fs.readFile(file, "utf8"))
      );
      if (
        event.runId !== runId ||
        event.sequence !== events.length ||
        name !== `${String(event.sequence).padStart(8, "0")}-${event.eventId}.json`
      )
        throw new Error("measurement_retention_journal_owner");
      const receipt = this.options
        .listArtifacts(runId)
        .find(
          (a) =>
            a.path === path.relative(root, file) &&
            a.sourceMetadata?.role === "retention-event" &&
            a.sourceMetadata?.eventId === event.eventId &&
            a.runId === runId
        );
      if (!receipt) throw new Error("measurement_retention_receipt_unavailable");
      events.push(event);
    }
    return events;
  }
  async project(target: Artifact) {
    const { file, attempt } = await this.owned(target);
    let present = false;
    try {
      const stat = await fs.lstat(file);
      present = stat.isFile() && !stat.isSymbolicLink() && (await fs.realpath(file)) === file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const events = await this.events(target.runId),
        pins = new Set<string>();
      for (const e of events.filter((e) => e.targetArtifactId === target.id)) {
        if (e.action === "PIN") pins.add(e.findingRef ?? "operator");
        if (e.action === "UNPIN") pins.delete(e.findingRef ?? "operator");
      }
      return {
        availability: projectDetailAvailability(
          present,
          { runId: target.runId, attemptId: attempt, artifactId: target.id },
          events
        ),
        pinned: pins.size > 0
      };
    } catch {
      return { availability: "UNAVAILABLE" as const, pinned: true, journalUnavailable: true };
    }
  }
  async projectArtifacts(artifacts: Artifact[]): Promise<Artifact[]> {
    return Promise.all(
      artifacts.map(async (artifact) => {
        if (
          artifact.kind !== "diagnostics" ||
          artifact.sourceMetadata?.contractVersion !== "measurement-diagnostics.v1" ||
          artifact.sourceMetadata?.role !== "trace"
        )
          return artifact;
        let projection: Awaited<ReturnType<MeasurementTraceRetention["project"]>>;
        try {
          projection = await this.project(artifact);
        } catch {
          projection = { availability: "UNAVAILABLE", pinned: true, journalUnavailable: true };
        }
        return {
          ...artifact,
          sourceMetadata: { ...artifact.sourceMetadata, retention: projection }
        };
      })
    );
  }
  private async locked<T>(runId: string, task: () => Promise<T>) {
    if (!this.options.isIdle()) throw new Error("measurement_retention_requires_idle");
    const root = await fs.realpath(this.options.artifactRoot),
      directory = path.join(root, id(runId), "measurement-diagnostics");
    if ((await fs.realpath(directory)) !== directory)
      throw new Error("measurement_retention_owner_invalid");
    const lock = path.join(directory, ".retention-lock");
    await fs.mkdir(lock, { mode: 0o700 });
    try {
      return await task();
    } finally {
      await fs.rmdir(lock);
    }
  }
  private async append(
    target: Artifact,
    action: RetentionEvent["action"],
    reasonCode: string,
    findingRef?: string,
    removedAtMs: number | null = null,
    errorCode?: string
  ) {
    const { owned, attempt } = await this.owned(target),
      run = this.options.run(target.runId),
      config = (run?.environmentSnapshot as any)
        ?.resolvedMeasurementDiagnostics as FrozenDiagnosticsConfig;
    if (!config) throw new Error("measurement_retention_budget_unavailable");
    const events = await this.events(target.runId);
    const event = validateMeasurementEvidence<RetentionEvent>({
      contractVersion: "measurement-diagnostics-retention.v1",
      eventId: randomUUID(),
      runId: target.runId,
      sequence: events.length,
      recordedAtMs: Date.now(),
      action,
      targetAttemptId: attempt,
      targetArtifactId: target.id,
      reasonCode,
      ...(findingRef ? { findingRef } : {}),
      removedAtMs,
      ...(errorCode ? { errorCode } : {})
    });
    projectDetailAvailability(
      action !== "EXPIRED",
      { runId: target.runId, attemptId: attempt, artifactId: target.id },
      [...events, event]
    );
    const store = await DiagnosticBudgetStore.attach(
      owned,
      target.runId,
      (run?.environmentSnapshot as any)?.measurementDiagnosticsEvidence?.runBudgetId,
      config
    );
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
    await store.charge("retention-control", bytes);
    const file = path.join(
      owned,
      "retention",
      `${String(event.sequence).padStart(8, "0")}-${event.eventId}.json`
    );
    await immutableJson(file, event, owned);
    this.options.registerArtifact(
      artifactRecord(
        target.runId,
        "diagnostics",
        {
          path: path.relative(await fs.realpath(this.options.artifactRoot), file),
          sizeBytes: bytes
        },
        "json",
        {
          contractVersion: "measurement-diagnostics-retention.v1",
          attemptId: attempt,
          role: "retention-event",
          eventId: event.eventId,
          targetArtifactId: target.id
        }
      )
    );
    return event;
  }
  pin(target: Artifact, findingRef: string) {
    return this.locked(target.runId, () =>
      this.append(target, "PIN", "open_finding", id(findingRef))
    );
  }
  unpin(target: Artifact, findingRef: string) {
    return this.locked(target.runId, async () => {
      const event = await this.append(target, "UNPIN", "finding_resolved", id(findingRef));
      await this.protectOpenFindingTraces(target.runId);
      return event;
    });
  }
  expire(target: Artifact, reasonCode: string) {
    return this.locked(target.runId, async () => {
      await this.protectOpenFindingTraces(target.runId);
      const state = await this.project(target);
      if (state.journalUnavailable) throw new Error("measurement_retention_journal_unavailable");
      if (state.pinned) throw new Error("measurement_retention_pinned");
      if (state.availability === "EXPIRED") return;
      const { file, owned } = await this.owned(target),
        run = this.options.run(target.runId);
      const store = await DiagnosticBudgetStore.attach(
        owned,
        target.runId,
        (run?.environmentSnapshot as any)?.measurementDiagnosticsEvidence?.runBudgetId,
        (run?.environmentSnapshot as any)?.resolvedMeasurementDiagnostics
      );
      if (
        ((await store.read()).reservations.find((r) => r.reservationId === "retention-control")
          ?.summaryBytes ?? 0) < 8192
      )
        throw new Error("measurement_retention_budget_exhausted");
      await this.append(target, "EXPIRE_REQUESTED", reasonCode);
      const backup = path.join(path.dirname(file), `.retention-backup-${randomUUID()}`);
      let linked = false,
        committed = false;
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || (await fs.realpath(file)) !== file)
          throw new Error("measurement_retention_file_invalid");
        await fs.link(file, backup);
        linked = true;
        await fs.unlink(file);
        try {
          await fs.lstat(file);
          throw new Error("measurement_retention_removal_unconfirmed");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await this.append(target, "EXPIRED", reasonCode, undefined, Date.now());
        committed = true;
        await fs.unlink(backup);
        linked = false;
      } catch (error) {
        if (linked && !committed) {
          await fs.link(backup, file).catch(() => {});
          await fs.unlink(backup).catch(() => {});
        }
        await this.append(
          target,
          "EXPIRE_FAILED",
          reasonCode,
          undefined,
          null,
          "removal_unconfirmed"
        ).catch(() => {});
        throw error;
      }
    });
  }
  /** One active reference protects a shared chunk. Further findings must not
   * multiply journal writes; resolving that reference atomically selects another. */
  private async protectOpenFindingTraces(runId: string) {
    const findingArtifacts = this.options
      .listArtifacts(runId)
      .filter(
        (a) =>
          a.kind === "diagnostics" &&
          a.sourceMetadata?.contractVersion === "measurement-diagnostics.v1" &&
          a.sourceMetadata?.role === "findings"
      );
    if (!findingArtifacts.length) return;
    const targets = this.options.allTraceArtifacts().filter((a) => a.runId === runId);
    const events = await this.events(runId);
    const states = targets.map((target) => {
      const last = new Map<string, string>();
      for (const event of events.filter((e) => e.targetArtifactId === target.id))
        if (event.action === "PIN" || event.action === "UNPIN")
          last.set(event.findingRef ?? "operator", event.action);
      return {
        target,
        last,
        protected: [...last.values()].includes("PIN"),
        candidate: undefined as string | undefined
      };
    });
    const root = await fs.realpath(this.options.artifactRoot);
    for (const artifact of findingArtifacts) {
      const attempt = id(String(artifact.sourceMetadata?.attemptId)),
        file = path.resolve(root, artifact.path);
      if (
        !file.startsWith(
          path.join(root, id(runId), "measurement-diagnostics", attempt, "findings") + path.sep
        ) ||
        (await fs.realpath(file)) !== file
      )
        throw new Error("measurement_retention_finding_owner_invalid");
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
        throw new Error("measurement_retention_finding_unavailable");
      const page = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Array.isArray(page)) throw new Error("measurement_retention_finding_unavailable");
      for (const envelope of page) {
        const finding = validateMeasurementEvidence<any>(envelope.record);
        if (finding.contractVersion !== "measurement-finding.v1" || finding.runId !== runId)
          throw new Error("measurement_retention_finding_owner_invalid");
        if (
          finding.state === "CONFIRMED" ||
          !["UNRESOLVED", "DEFECT"].includes(finding.classification)
        )
          continue;
        for (const state of states)
          if (!state.protected && !state.candidate && state.last.get(finding.findingId) !== "UNPIN")
            state.candidate = finding.findingId;
      }
    }
    for (const state of states)
      if (!state.protected && state.candidate)
        await this.append(state.target, "PIN", "open_finding", id(state.candidate));
  }
  async pinOpenFindings() {
    const runs = new Set(this.options.allTraceArtifacts().map((a) => a.runId));
    for (const runId of runs) await this.locked(runId, () => this.protectOpenFindingTraces(runId));
  }
  async prepareBatch(options: { nowMs?: number; limitBytes?: number; requestedBytes: number }) {
    if (!this.options.isIdle()) throw new Error("measurement_retention_requires_idle");
    const now = options.nowMs ?? Date.now(),
      limit = options.limitBytes ?? DIAGNOSTIC_DEFAULTS.retainedTraceLimitBytes;
    if (
      !Number.isSafeInteger(options.requestedBytes) ||
      options.requestedBytes < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 0
    )
      throw new Error("measurement_retention_capacity_invalid");
    const configuredRuns =
      this.options.allDiagnosticRuns?.() ??
      [...new Set(this.options.allTraceArtifacts().map((artifact) => artifact.runId))]
        .map((runId) => this.options.run(runId))
        .filter(Boolean);
    // Committed allocations without a downloadable trace still occupy the
    // global bound conservatively (for example a quiescent killed producer).
    const indexedByRun = new Map<string, number>();
    for (const artifact of this.options.allTraceArtifacts()) {
      if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0)
        throw new Error("measurement_retention_size_unavailable");
      indexedByRun.set(
        artifact.runId,
        (indexedByRun.get(artifact.runId) ?? 0) + artifact.sizeBytes
      );
    }
    let unindexedTraceBytes = 0;
    for (const run of configuredRuns) {
      const snapshot = run.environmentSnapshot as any,
        config = snapshot?.resolvedMeasurementDiagnostics as FrozenDiagnosticsConfig;
      if (config?.mode !== "trace" || !snapshot?.measurementDiagnosticsEvidence?.attemptId)
        continue;
      try {
        const store = await DiagnosticBudgetStore.attach(
          path.join(this.options.artifactRoot, id(run.id), "measurement-diagnostics"),
          run.id,
          snapshot.measurementDiagnosticsEvidence.runBudgetId,
          config
        );
        const ledger = await store.read();
        if (
          ledger.accountingState !== "CONFIRMED" ||
          ledger.reservations.some(
            (reservation) => reservation.reservationId !== "retention-control"
          )
        )
          throw new Error("measurement_retention_budget_unavailable");
        unindexedTraceBytes += Math.max(
          0,
          ledger.committedTraceBytes - (indexedByRun.get(run.id) ?? 0)
        );
      } catch {
        throw new Error("measurement_retention_budget_unavailable");
      }
    }
    await this.pinOpenFindings();
    let retained = unindexedTraceBytes;
    for (const target of this.options.allTraceArtifacts()) {
      const location = await this.owned(target);
      if (
        (await fs.readdir(path.dirname(location.file))).some((name) =>
          name.startsWith(".retention-backup-")
        )
      )
        throw new Error("measurement_retention_recovery_required");
      const projection = await this.project(target);
      if (projection.journalUnavailable)
        throw new Error("measurement_retention_pin_evidence_unavailable");
      if (projection.availability === "EXPIRED") continue;
      if (projection.availability !== "AVAILABLE")
        throw new Error("measurement_retention_detail_unavailable");
      const config = (this.options.run(target.runId)?.environmentSnapshot as any)
        ?.resolvedMeasurementDiagnostics as FrozenDiagnosticsConfig;
      const ttl = config?.traceTtlMs ?? DIAGNOSTIC_DEFAULTS.traceTtlMs;
      if (!projection.pinned && now - Date.parse(target.createdAt) >= ttl) {
        await this.expire(target, "detail_ttl_elapsed");
        continue;
      }
      const { file } = await this.owned(target);
      retained += (await fs.stat(file)).size;
    }
    if (retained + options.requestedBytes > limit)
      throw new Error("measurement_retention_trace_capacity_exhausted");
    return { retainedBytes: retained, availableBytes: limit - retained, unindexedTraceBytes };
  }
}
