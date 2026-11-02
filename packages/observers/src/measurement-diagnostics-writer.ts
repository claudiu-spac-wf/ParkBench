import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DIAGNOSTIC_DEFAULTS,
  DiagnosticReservation,
  ObservationEvidence,
  RunBudgetLedger,
  reserveDiagnosticBudget,
  settleDiagnosticBudget,
  validateMeasurementEvidence,
  validateBudgetProgress
} from "../../contracts/src/measurement-diagnostics";
import { redactSecrets } from "../../contracts/src/redaction";

function opaque(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new Error("measurement_diagnostics_invalid:owned_identity");
  return value;
}
async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
/** All I/O here occurs at allocation/reconciliation boundaries, never in record(). */
export class DiagnosticBudgetStore {
  private constructor(
    readonly directory: string,
    readonly runId: string
  ) {}
  static async open(
    root: string,
    runId: string,
    limits: { summaryLimitBytes: number; traceLimitBytes: number; retentionControlBytes?: number }
  ): Promise<DiagnosticBudgetStore> {
    opaque(runId);
    await fs.mkdir(root, { recursive: true });
    const canonicalRoot = await fs.realpath(root);
    const directory = path.join(canonicalRoot, runId, "measurement-diagnostics");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await fs.realpath(directory)) !== directory)
      throw new Error("measurement_diagnostics_invalid:symlink_path");
    const store = new DiagnosticBudgetStore(directory, runId);
    await store.lock(async () => {
      let ledger: RunBudgetLedger;
      try {
        ledger = await store.readUnlocked();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const entries = (await fs.readdir(directory)).filter((n) => n !== ".budget-lock");
        if (entries.length)
          throw new Error("measurement_diagnostics_budget_unconfirmed:missing_ledger");
        ledger = validateMeasurementEvidence<RunBudgetLedger>({
          contractVersion: "measurement-diagnostics-budget.v1",
          runId,
          runBudgetId: randomUUID(),
          summaryLimitBytes: limits.summaryLimitBytes,
          traceLimitBytes: limits.traceLimitBytes,
          committedSummaryBytes: 0,
          committedTraceBytes: 0,
          reservations: [],
          accountingState: "CONFIRMED",
          revision: 0
        });
        await atomicJson(store.file, ledger);
      }
      if (
        ledger.runId !== runId ||
        ledger.summaryLimitBytes !== limits.summaryLimitBytes ||
        ledger.traceLimitBytes !== limits.traceLimitBytes
      )
        throw new Error("measurement_diagnostics_invalid:frozen_budget");
    });
    if (limits.retentionControlBytes !== undefined)
      await store.reserveControl(limits.retentionControlBytes);
    return store;
  }
  /** Attach to an already frozen run ledger mounted into an owned producer.
   * Missing accounting is never initialized by a child process. */
  static async attach(
    directory: string,
    runId: string,
    runBudgetId: string,
    limits: { summaryLimitBytes: number; traceLimitBytes: number }
  ) {
    opaque(runId);
    const canonical = await fs.realpath(directory);
    if (canonical !== path.resolve(directory))
      throw new Error("measurement_diagnostics_invalid:symlink_path");
    const store = new DiagnosticBudgetStore(canonical, runId);
    const ledger = await store.read();
    if (
      ledger.runBudgetId !== runBudgetId ||
      ledger.summaryLimitBytes !== limits.summaryLimitBytes ||
      ledger.traceLimitBytes !== limits.traceLimitBytes
    )
      throw new Error("measurement_diagnostics_invalid:producer_budget_owner");
    return store;
  }
  private get file() {
    return path.join(this.directory, "budget.json");
  }
  private async readUnlocked(): Promise<RunBudgetLedger> {
    const stat = await fs.stat(this.file);
    if (!stat.isFile() || stat.size > 128 * 1024)
      throw new Error("measurement_diagnostics_budget_unconfirmed:ledger_size");
    const result = validateMeasurementEvidence<RunBudgetLedger>(
      JSON.parse(await fs.readFile(this.file, "utf8"))
    );
    if (result.runId !== this.runId)
      throw new Error("measurement_diagnostics_invalid:budget_owner");
    return result;
  }
  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.directory, ".budget-lock");
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        await fs.mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error("measurement_diagnostics_budget_unconfirmed:lock");
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rmdir(lockPath);
    }
  }
  async read() {
    return this.lock(() => this.readUnlocked());
  }
  async reserve(reservation: DiagnosticReservation) {
    return this.update((ledger) => reserveDiagnosticBudget(ledger, reservation));
  }
  async settle(
    reservationId: string,
    summaryBytes: number,
    traceBytes: number,
    quiescent: boolean
  ) {
    return this.update((ledger) =>
      settleDiagnosticBudget(ledger, reservationId, summaryBytes, traceBytes, quiescent)
    );
  }
  async reserveControl(summaryBytes: number) {
    return this.lock(async () => {
      const before = await this.readUnlocked();
      const existing = before.reservations.find((r) => r.reservationId === "retention-control");
      if (existing) return before;
      if (before.revision !== 0)
        throw new Error("measurement_diagnostics_budget_unconfirmed:control_reservation_missing");
      const after = reserveDiagnosticBudget(before, {
        reservationId: "retention-control",
        attemptId: "run-lifetime",
        producerId: "retention",
        summaryBytes,
        traceBytes: 0
      });
      await atomicJson(this.file, after);
      return after;
    });
  }
  /** Commit control/page bytes before I/O; failed writes cannot refund usage. */
  async charge(reservationId: string, summaryBytes: number, traceBytes = 0) {
    return this.update((ledger) => {
      if (ledger.accountingState !== "CONFIRMED")
        throw new Error("measurement_diagnostics_budget_unconfirmed");
      const r = ledger.reservations.find((r) => r.reservationId === reservationId);
      if (
        !r ||
        !Number.isSafeInteger(summaryBytes) ||
        summaryBytes < 0 ||
        !Number.isSafeInteger(traceBytes) ||
        traceBytes < 0 ||
        summaryBytes > r.summaryBytes ||
        traceBytes > r.traceBytes
      )
        throw new Error("measurement_diagnostics_budget_exhausted");
      r.summaryBytes -= summaryBytes;
      r.traceBytes -= traceBytes;
      ledger.committedSummaryBytes += summaryBytes;
      ledger.committedTraceBytes += traceBytes;
      ledger.revision++;
      return ledger;
    });
  }
  /** Final summary snapshot includes its own charge; unused allocation is released
   * only by this quiescent producer, atomically with cumulative accounting. */
  async sealSnapshot(
    reservationId: string,
    render: (ledger: RunBudgetLedger) => unknown,
    framingBytes = 0
  ) {
    return this.lock(async () => {
      const before = await this.readUnlocked();
      const reservation = before.reservations.find((r) => r.reservationId === reservationId);
      if (!reservation) throw new Error("measurement_diagnostics_budget_unconfirmed:snapshot");
      if (
        !Number.isSafeInteger(framingBytes) ||
        framingBytes < 0 ||
        framingBytes > reservation.summaryBytes
      )
        throw new Error("measurement_diagnostics_invalid:framing");
      let bytes = framingBytes,
        payload: unknown,
        after: RunBudgetLedger;
      for (let attempt = 0; attempt < 16; attempt++) {
        after = settleDiagnosticBudget(before, reservationId, bytes, 0, true);
        payload = render(after);
        if (
          before.accountingState === "UNCONFIRMED" &&
          (payload as any)?.recordingState !== "UNAVAILABLE"
        )
          throw new Error("measurement_diagnostics_budget_unconfirmed:snapshot_state");
        const size = Buffer.byteLength(JSON.stringify(payload)) + 1 + framingBytes;
        if (size > reservation.summaryBytes)
          throw new Error("measurement_diagnostics_budget_exhausted:manifest");
        if (size === bytes) {
          validateBudgetProgress(before, after);
          await atomicJson(this.file, after);
          return { payload, ledger: after, bytes };
        }
        bytes = size;
      }
      throw new Error("measurement_diagnostics_invalid:snapshot_size");
    });
  }
  /** After independently verified quiescence, keep the full uncertain allocation
   * charged. This confirms a conservative upper bound, never producer completeness. */
  async reconcileUncertainReservations(
    expectedRevision: number,
    receiptBytes: number,
    writeReceipt: () => Promise<void>
  ) {
    return this.lock(async () => {
      const before = await this.readUnlocked(),
        ledger = structuredClone(before);
      if (
        ledger.revision !== expectedRevision ||
        !Number.isSafeInteger(receiptBytes) ||
        receiptBytes <= 0 ||
        receiptBytes > 4096
      )
        throw new Error("measurement_diagnostics_recovery_conflict");
      const control = ledger.reservations.find((r) => r.reservationId === "retention-control");
      if (
        !control ||
        control.attemptId !== "run-lifetime" ||
        control.producerId !== "retention" ||
        receiptBytes > control.summaryBytes
      )
        throw new Error("measurement_diagnostics_recovery_receipt_budget");
      for (const reservation of ledger.reservations)
        if (reservation !== control) {
          ledger.committedSummaryBytes += reservation.summaryBytes;
          ledger.committedTraceBytes += reservation.traceBytes;
        }
      control.summaryBytes -= receiptBytes;
      ledger.committedSummaryBytes += receiptBytes;
      ledger.reservations = [control];
      ledger.accountingState = "UNCONFIRMED";
      ledger.revision++;
      validateBudgetProgress(before, ledger);
      // Charge first. A failed receipt consumes bytes and leaves grants blocked.
      await atomicJson(this.file, ledger);
      await writeReceipt();
      const confirmed = {
        ...ledger,
        accountingState: "CONFIRMED" as const,
        revision: ledger.revision + 1
      };
      validateBudgetProgress(ledger, confirmed);
      await atomicJson(this.file, confirmed);
      return confirmed;
    });
  }
  async markUnconfirmed() {
    return this.update((ledger) => ({
      ...ledger,
      accountingState: "UNCONFIRMED",
      revision: ledger.revision + 1
    }));
  }
  private async update(fn: (ledger: RunBudgetLedger) => RunBudgetLedger) {
    return this.lock(async () => {
      const before = await this.readUnlocked(),
        after = fn(structuredClone(before));
      validateBudgetProgress(before, after);
      await atomicJson(this.file, after);
      return after;
    });
  }
}

type ObservationInput = Omit<
  ObservationEvidence,
  | "contractVersion"
  | "eventId"
  | "runId"
  | "experimentId"
  | "diagnosticAttemptId"
  | "component"
  | "componentInstanceId"
  | "sequence"
>;
export interface DiagnosticsWriterOptions {
  runId: string;
  experimentId: string;
  diagnosticAttemptId: string;
  component: string;
  mode: "summary" | "trace";
  summaryBytes: number;
  traceBytes: number;
  pendingLimitBytes?: number;
  eventLimitBytes?: number;
  flushIntervalMs?: number;
  secrets?: string[];
  /** Trusted fixed allowlist validator supplied by the controller metadata producer. */
  metadataValidator?: (input: unknown) => unknown;
  sink?: (line: string, kind: "summary" | "trace") => Promise<void>;
}
/** A bounded, nonblocking callback. Sink latency never becomes acquisition latency. */
export class MeasurementDiagnosticsWriter {
  readonly componentInstanceId = randomUUID();
  readonly reservationId = randomUUID();
  private sequence = 0;
  private attemptedEvents = 0;
  private retainedEvents = 0;
  private acceptedEvents = 0;
  private droppedEvents = 0;
  private lostSequenceRanges: Array<[number, number]> = [];
  private lostSequenceRangesIncomplete = false;
  private droppedMetadataRecords = 0;
  private writeFailures = 0;
  private summaryBytes = 0;
  private traceBytes = 0;
  private pendingBytes = 0;
  private workingBytes = 0;
  private queue: Array<{
    line: string;
    kind: "summary" | "trace";
    bytes: number;
    representedEvents: number;
  }> = [];
  private pendingAggregates = new Map<
    string,
    { stage: string; outcome: string; count: number; durationMs: number }
  >();
  private aggregates = new Map<
    string,
    { stage: string; outcome: string; count: number; durationMs: number }
  >();
  private draining?: Promise<void>;
  private closing?: Promise<ReturnType<MeasurementDiagnosticsWriter["snapshot"]>>;
  private closed = false;
  private unavailable = false;
  private timer?: ReturnType<typeof setInterval>;
  private handles = new Map<string, fs.FileHandle>();
  private constructor(
    private store: DiagnosticBudgetStore,
    private options: DiagnosticsWriterOptions
  ) {}
  static async create(store: DiagnosticBudgetStore, options: DiagnosticsWriterOptions) {
    opaque(options.runId);
    opaque(options.diagnosticAttemptId);
    opaque(options.component);
    if (options.runId !== store.runId || !["summary", "trace"].includes(options.mode))
      throw new Error("measurement_diagnostics_invalid:writer_owner_or_mode");
    const positive = (v: number, max: number) => Number.isSafeInteger(v) && v > 0 && v <= max;
    if (
      !positive(
        options.pendingLimitBytes ?? DIAGNOSTIC_DEFAULTS.pendingLimitBytes,
        DIAGNOSTIC_DEFAULTS.pendingLimitBytes
      ) ||
      !positive(
        options.eventLimitBytes ?? DIAGNOSTIC_DEFAULTS.eventLimitBytes,
        DIAGNOSTIC_DEFAULTS.eventLimitBytes
      ) ||
      !positive(options.flushIntervalMs ?? DIAGNOSTIC_DEFAULTS.flushIntervalMs, 1000) ||
      options.summaryBytes < 2048 ||
      (options.mode === "summary" && options.traceBytes !== 0)
    )
      throw new Error("measurement_diagnostics_invalid:writer_bounds");
    const writer = new MeasurementDiagnosticsWriter(store, options);
    await store.reserve({
      reservationId: writer.reservationId,
      attemptId: options.diagnosticAttemptId,
      producerId: `${options.component}-${writer.componentInstanceId}`,
      summaryBytes: options.summaryBytes,
      traceBytes: options.traceBytes
    });
    try {
      if (!options.sink) {
        const attemptDir = path.join(store.directory, options.diagnosticAttemptId);
        for (const kind of options.mode === "trace" ? ["summary", "trace"] : ["summary"]) {
          const dir = path.join(attemptDir, kind);
          await fs.mkdir(dir, {
            recursive: true,
            mode: 0o700
          });
          if ((await fs.realpath(dir)) !== dir)
            throw new Error("measurement_diagnostics_invalid:symlink_path");
          const file = path.join(dir, `${options.component}-${writer.componentInstanceId}.jsonl`);
          const handle = await fs.open(file, "wx", 0o600);
          writer.handles.set(kind, handle);
        }
      }
      writer.timer = setInterval(() => {
        void writer.flush();
      }, options.flushIntervalMs ?? DIAGNOSTIC_DEFAULTS.flushIntervalMs);
      writer.timer.unref();
      return writer;
    } catch (error) {
      for (const handle of writer.handles.values()) await handle.close().catch(() => {});
      await store.markUnconfirmed().catch(() => {});
      throw error;
    }
  }
  record(input: ObservationInput): string | undefined {
    if (this.closed) return;
    const sequence = this.sequence++;
    this.attemptedEvents++;
    if (this.unavailable) {
      this.drop(sequence);
      return;
    }
    let event: ObservationEvidence;
    try {
      // Validate before redaction to reject unknown/unbounded input without copying it.
      const original = validateMeasurementEvidence<ObservationEvidence>({
        ...input,
        contractVersion: "measurement-observation.v1",
        eventId: `${this.componentInstanceId}:${sequence}`,
        runId: this.options.runId,
        experimentId: this.options.experimentId,
        diagnosticAttemptId: this.options.diagnosticAttemptId,
        component: this.options.component,
        componentInstanceId: this.componentInstanceId,
        sequence
      });
      event = redactSecrets(original, this.options.secrets) as ObservationEvidence;
      if (JSON.stringify(original) !== JSON.stringify(event)) this.droppedMetadataRecords++;
    } catch {
      this.drop(sequence);
      return;
    }
    if (event.stage === "DIAGNOSTIC_WRITE" && event.outcome === "REJECTED")
      this.droppedMetadataRecords++;
    const key = `${event.stage}:${event.outcome}`;
    if (
      !this.aggregates.has(key) &&
      this.pendingBytes + (this.aggregates.size + 1) * 256 >
        (this.options.pendingLimitBytes ?? DIAGNOSTIC_DEFAULTS.pendingLimitBytes)
    ) {
      this.drop(sequence);
      return;
    }
    const aggregate = this.aggregates.get(key) ?? {
      stage: event.stage,
      outcome: event.outcome,
      count: 0,
      durationMs: 0
    };
    aggregate.count++;
    aggregate.durationMs += event.durationMs;
    this.aggregates.set(key, aggregate);
    const delta = this.pendingAggregates.get(key) ?? {
      stage: event.stage,
      outcome: event.outcome,
      count: 0,
      durationMs: 0
    };
    delta.count++;
    delta.durationMs += event.durationMs;
    this.pendingAggregates.set(key, delta);
    if (this.options.mode === "summary") {
      // Preserve the identities behind phase/skip/error aggregates. Aggregate
      // copies represent the event count; these compact records add attribution.
      if (
        sequence === 0 ||
        event.stage === "SCHEDULE" ||
        !["STARTED", "SUCCEEDED", "SHARED"].includes(event.outcome)
      ) {
        if (!this.enqueue(JSON.stringify(event) + "\n", "summary", 0)) {
          this.droppedMetadataRecords++;
          this.lostSequenceRangesIncomplete = true;
        }
      }
      this.acceptedEvents++;
      return event.eventId;
    }
    const line = JSON.stringify(event) + "\n";
    if (this.enqueue(line, "trace", 1)) this.acceptedEvents++;
    else this.drop(sequence);
    return event.eventId;
  }
  markIncomplete() {
    this.droppedMetadataRecords++;
  }
  reserveWorkingMemory(bytes: number): (() => void) | undefined {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.pendingBytes + this.workingBytes + this.aggregates.size * 256 + bytes >
        (this.options.pendingLimitBytes ?? DIAGNOSTIC_DEFAULTS.pendingLimitBytes)
    )
      return;
    this.workingBytes += bytes;
    let released = false;
    return () => {
      if (!released) {
        this.workingBytes -= bytes;
        released = true;
      }
    };
  }
  /** Only a controller-installed, fixed-schema validator can enable structured metadata. */
  recordStructured(input: unknown): string | undefined {
    if (this.closed) return;
    const sequence = this.sequence++;
    this.attemptedEvents++;
    if (this.unavailable || !this.options.metadataValidator) {
      this.drop(sequence);
      return;
    }
    try {
      const record = this.options.metadataValidator(input);
      const eventId = `${this.componentInstanceId}:${sequence}`;
      const original = {
        contractVersion: "measurement-evidence-record.v1",
        eventId,
        runId: this.options.runId,
        diagnosticAttemptId: this.options.diagnosticAttemptId,
        componentInstanceId: this.componentInstanceId,
        sequence,
        record
      };
      const envelope = redactSecrets(original, this.options.secrets);
      if (JSON.stringify(original) !== JSON.stringify(envelope)) this.droppedMetadataRecords++;
      const line = JSON.stringify(envelope) + "\n";
      if (!this.enqueue(line, "summary", 1)) {
        this.drop(sequence);
        return;
      }
      this.acceptedEvents++;
      return eventId;
    } catch {
      this.drop(sequence);
      return;
    }
  }
  private drop(sequence: number) {
    this.droppedEvents++;
    const last = this.lostSequenceRanges.at(-1);
    if (last && last[1] === sequence - 1) last[1] = sequence;
    else if (this.lostSequenceRanges.length < 32)
      this.lostSequenceRanges.push([sequence, sequence]);
    else this.lostSequenceRangesIncomplete = true;
  }
  private enqueue(line: string, kind: "summary" | "trace", representedEvents = 0): boolean {
    const bytes = Buffer.byteLength(line);
    const limit = kind === "summary" ? this.options.summaryBytes - 2048 : this.options.traceBytes;
    const used = kind === "summary" ? this.summaryBytes : this.traceBytes;
    if (
      bytes > (this.options.eventLimitBytes ?? DIAGNOSTIC_DEFAULTS.eventLimitBytes) ||
      bytes + used > limit ||
      bytes + this.pendingBytes + this.workingBytes + this.aggregates.size * 256 >
        (this.options.pendingLimitBytes ?? DIAGNOSTIC_DEFAULTS.pendingLimitBytes)
    )
      return false;
    this.pendingBytes += bytes;
    if (kind === "summary") this.summaryBytes += bytes;
    else this.traceBytes += bytes;
    this.queue.push({ line, kind, bytes, representedEvents });
    return true;
  }
  flush(): Promise<void> {
    if (this.draining) return this.draining;
    this.enqueueAggregates();
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }
  private enqueueAggregates() {
    for (const aggregate of this.pendingAggregates.values()) {
      const line =
        JSON.stringify({
          contractVersion: "measurement-stage-aggregate.v1",
          runId: this.options.runId,
          diagnosticAttemptId: this.options.diagnosticAttemptId,
          componentInstanceId: this.componentInstanceId,
          ...aggregate
        }) + "\n";
      if (!this.enqueue(line, "summary", this.options.mode === "summary" ? aggregate.count : 0)) {
        this.droppedMetadataRecords++;
        if (this.options.mode === "summary") {
          this.droppedEvents += aggregate.count;
          this.lostSequenceRangesIncomplete = true;
        }
      }
    }
    this.pendingAggregates.clear();
  }
  private async drain() {
    while (this.queue.length) {
      const item = this.queue.shift()!;
      try {
        if (this.unavailable) continue;
        if (this.options.sink) await this.options.sink(item.line, item.kind);
        else await this.handles.get(item.kind)!.writeFile(item.line);
        this.retainedEvents += item.representedEvents;
      } catch {
        // Never retain arbitrary filesystem/error text. An uncertain partial write
        // keeps its entire reservation charged until explicit reconciliation.
        this.writeFailures++;
        this.unavailable = true;
      } finally {
        this.pendingBytes -= item.bytes;
      }
    }
  }
  snapshot() {
    return {
      component: this.options.component,
      componentInstanceId: this.componentInstanceId,
      reservationId: this.reservationId,
      sequenceStart: 0,
      sequenceEnd: Math.max(0, this.sequence - 1),
      attemptedEvents: this.attemptedEvents,
      acceptedEvents: this.acceptedEvents,
      unconfirmedEvents: this.unavailable
        ? Math.max(0, this.attemptedEvents - this.retainedEvents - this.droppedEvents)
        : 0,
      lostSequenceRanges: this.lostSequenceRanges.map((range) => [...range] as [number, number]),
      lostSequenceRangesIncomplete: this.lostSequenceRangesIncomplete,
      retainedEvents: this.retainedEvents,
      droppedEvents: this.droppedEvents,
      droppedMetadataRecords: this.droppedMetadataRecords,
      writeFailures: this.writeFailures,
      summaryBytes: this.summaryBytes,
      traceBytes: this.traceBytes,
      pendingBytes: this.pendingBytes + this.workingBytes + this.aggregates.size * 256,
      recordingState: this.unavailable
        ? "UNAVAILABLE"
        : this.droppedEvents || this.droppedMetadataRecords
          ? "TRUNCATED"
          : this.closed
            ? "SEALED"
            : "RECORDING",
      budgetAccountingState: this.unavailable ? "UNCONFIRMED" : "CONFIRMED",
      flushState: this.unavailable ? "FAILED" : this.pendingBytes ? "PENDING" : "COMPLETE",
      aggregates: [...this.aggregates.values()].map((a) => ({ ...a }))
    };
  }
  close(): Promise<ReturnType<MeasurementDiagnosticsWriter["snapshot"]>> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.timer);
    this.closing = this.finish();
    return this.closing;
  }
  private async finish() {
    await this.flush();
    await this.flush();
    let bytes = 0,
      terminal = "";
    for (let attempt = 0; attempt < 16; attempt++) {
      terminal =
        JSON.stringify({
          contractVersion: "measurement-producer-terminal.v1",
          ...this.snapshot(),
          summaryBytes: this.summaryBytes + bytes,
          aggregates: undefined
        }) + "\n";
      const size = Buffer.byteLength(terminal);
      if (size === bytes) break;
      bytes = size;
    }
    if (
      bytes <= 2048 &&
      this.summaryBytes + bytes <= this.options.summaryBytes &&
      !this.unavailable
    ) {
      try {
        if (this.options.sink) await this.options.sink(terminal, "summary");
        else await this.handles.get("summary")!.writeFile(terminal);
        this.summaryBytes += bytes;
      } catch {
        this.writeFailures++;
        this.unavailable = true;
      }
    } else if (!this.unavailable) {
      this.writeFailures++;
      this.unavailable = true;
    }
    for (const handle of this.handles.values()) {
      try {
        await handle.sync();
        await handle.close();
      } catch {
        this.writeFailures++;
        this.unavailable = true;
      }
    }
    try {
      if (this.unavailable) await this.store.markUnconfirmed();
      else await this.store.settle(this.reservationId, this.summaryBytes, this.traceBytes, true);
    } catch {
      this.unavailable = true;
      this.writeFailures++;
    }
    return this.snapshot();
  }
}
