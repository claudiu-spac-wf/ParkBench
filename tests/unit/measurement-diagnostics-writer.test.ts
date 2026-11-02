import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DiagnosticBudgetStore,
  MeasurementDiagnosticsWriter
} from "../../packages/observers/src/measurement-diagnostics-writer";
import { DIAGNOSTIC_DEFAULTS } from "../../packages/contracts/src/measurement-diagnostics";
const base = {
  runId: "run-1",
  experimentId: "experiment-1",
  diagnosticAttemptId: "a1",
  component: "controller"
};
const e = {
  stage: "HTTP" as const,
  outcome: "SUCCEEDED" as const,
  scheduledAtMs: null,
  startedAtMs: 1,
  finishedAtMs: 2,
  sourceCapturedAtMs: null,
  availableAtMs: 2,
  timestampOrigin: "UNKNOWN" as const,
  durationMs: 1,
  queueWaitMs: 0,
  bodyReadMs: 0,
  callerRole: "UNKNOWN" as const
};
async function fixture(t: any, limits = { summaryLimitBytes: 8192, traceLimitBytes: 16384 }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-diagnostics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await DiagnosticBudgetStore.open(root, "run-1", limits);
  return { root, store, limits };
}
test("slow async sink never blocks capture; pending bytes include in-flight data and produce explicit loss", async (t) => {
  const { store } = await fixture(t);
  let unblock!: () => void;
  const held = new Promise<void>((r) => {
    unblock = r;
  });
  const output: string[] = [];
  const writer = await MeasurementDiagnosticsWriter.create(store, {
    ...base,
    mode: "trace",
    summaryBytes: 8192,
    traceBytes: 16384,
    pendingLimitBytes: 2048,
    eventLimitBytes: 1024,
    flushIntervalMs: 1000,
    sink: async (data) => {
      await held;
      output.push(data);
    }
  });
  for (let i = 0; i < 50; i++) writer.record(e);
  assert.ok(writer.snapshot().droppedEvents > 0);
  assert.ok(writer.snapshot().pendingBytes <= 2048);
  const flushing = writer.flush();
  writer.record(e);
  assert.ok(writer.snapshot().pendingBytes <= 2048);
  unblock();
  await flushing;
  const terminal = await writer.close();
  assert.equal(terminal.recordingState, "TRUNCATED");
  assert.equal(terminal.attemptedEvents, 51);
  assert.equal(terminal.retainedEvents + terminal.droppedEvents, 51);
  assert.ok(output.every((line) => Buffer.byteLength(line) <= 1024));
  assert.equal((await store.read()).reservations.length, 0);
});
test("summary retains bounded aggregate evidence without trace; privacy errors never echo unsafe payloads", async (t) => {
  const { store } = await fixture(t);
  const output: string[] = [];
  const writer = await MeasurementDiagnosticsWriter.create(store, {
    ...base,
    mode: "summary",
    summaryBytes: 8192,
    traceBytes: 0,
    secrets: ["fixture-sensitive"],
    sink: async (data) => {
      output.push(data);
    }
  });
  for (let i = 0; i < 100; i++) writer.record(e);
  writer.record({ ...e, reasonCodes: ["fixture-sensitive"] });
  writer.record({ ...e, responseBody: "fixture-sensitive" } as any);
  const terminal = await writer.close();
  assert.equal(terminal.traceBytes, 0);
  assert.equal(terminal.droppedEvents, 1);
  assert.ok(!output.join("").includes("fixture-sensitive"));
  assert.equal(
    output
      .map((line) => JSON.parse(line))
      .filter((record) => record.contractVersion === "measurement-observation.v1").length,
    1
  );
  assert.equal(terminal.aggregates.find((a) => a.stage === "HTTP")?.count, 101);
});
test("write failures remain UNAVAILABLE independently of measurements, and uncertain bytes are not refunded", async (t) => {
  const { store } = await fixture(t);
  const writer = await MeasurementDiagnosticsWriter.create(store, {
    ...base,
    mode: "trace",
    summaryBytes: 8192,
    traceBytes: 16384,
    sink: async () => {
      throw new Error("ENOSPC token=private");
    }
  });
  writer.record(e);
  const terminal = await writer.close();
  assert.equal(terminal.recordingState, "UNAVAILABLE");
  assert.ok(terminal.writeFailures > 0);
  assert.equal((await store.read()).accountingState, "UNCONFIRMED");
  assert.ok((await store.read()).reservations.length > 0);
  assert.ok(!JSON.stringify(terminal).includes("private"));
});
test("concurrent stores cannot oversubscribe one run; audit/restart and deletion never refill committed usage", async (t) => {
  const { root, store, limits } = await fixture(t);
  const other = await DiagnosticBudgetStore.open(root, "run-1", limits);
  const reservation = (n: number) => ({
    reservationId: `p${n}`,
    attemptId: `a${n}`,
    producerId: "controller",
    summaryBytes: 8192,
    traceBytes: 16384
  });
  const grants = await Promise.allSettled([
    store.reserve(reservation(1)),
    other.reserve(reservation(2))
  ]);
  assert.equal(grants.filter((g) => g.status === "fulfilled").length, 1);
  const r = (await store.read()).reservations[0];
  await store.settle(r.reservationId, 8192, 16384, true);
  const reopened = await DiagnosticBudgetStore.open(root, "run-1", limits);
  await assert.rejects(() => reopened.reserve(reservation(3)));
  await assert.rejects(() =>
    DiagnosticBudgetStore.open(root, "run-1", { ...limits, summaryLimitBytes: 16384 })
  );
  assert.equal((await reopened.read()).committedTraceBytes, 16384);
});
test("fresh producer filenames preserve previous instance files; lost ledger refuses a fresh allowance", async (t) => {
  const { root, store, limits } = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const writer = await MeasurementDiagnosticsWriter.create(store, {
      ...base,
      mode: "trace",
      summaryBytes: 4096,
      traceBytes: 8192
    });
    writer.record(e);
    await writer.close();
  }
  const trace = await fs.readdir(
    path.join(root, "run-1", "measurement-diagnostics", "a1", "trace")
  );
  assert.equal(trace.length, 2);
  await fs.unlink(path.join(root, "run-1", "measurement-diagnostics", "budget.json"));
  await assert.rejects(() => DiagnosticBudgetStore.open(root, "run-1", limits));
});
test("oversize invalid input, contained paths and invalid writer bounds fail honestly", async (t) => {
  const { store, root, limits } = await fixture(t);
  await assert.rejects(() => DiagnosticBudgetStore.open(root, "../outside", limits));
  await assert.rejects(() =>
    MeasurementDiagnosticsWriter.create(store, {
      ...base,
      mode: "trace",
      summaryBytes: 8192,
      traceBytes: 16384,
      pendingLimitBytes: DIAGNOSTIC_DEFAULTS.pendingLimitBytes + 1
    })
  );
  const w = await MeasurementDiagnosticsWriter.create(store, {
    ...base,
    mode: "trace",
    summaryBytes: 8192,
    traceBytes: 16384
  });
  w.record({ ...e, reasonCodes: ["x".repeat(5000)] });
  const terminal = await w.close();
  assert.equal(terminal.droppedEvents, 1);
  assert.equal(terminal.recordingState, "TRUNCATED");
});

test("retention-control space is reserved before producers; deletion cannot refill its journal allowance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-diagnostic-control-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const limits = { summaryLimitBytes: 8192, traceLimitBytes: 8192, retentionControlBytes: 2048 };
  const store = await DiagnosticBudgetStore.open(root, "run-1", limits);
  await assert.rejects(() =>
    store.reserve({
      reservationId: "producer",
      attemptId: "a1",
      producerId: "controller",
      summaryBytes: 8192,
      traceBytes: 1
    })
  );
  await store.charge("retention-control", 1024);
  const restored = await DiagnosticBudgetStore.open(root, "run-1", limits);
  assert.equal((await restored.read()).reservations[0].summaryBytes, 1024);
  await assert.rejects(() => restored.charge("retention-control", 1025));
  await restored.charge("retention-control", 1024);
  await assert.rejects(() => restored.charge("retention-control", 1));
  assert.equal((await restored.read()).committedSummaryBytes, 2048);
});
test("summary flush retains stage deltas during the run; aggregate cardinality cannot exceed the pending bound", async (t) => {
  const { store } = await fixture(t);
  const lines: string[] = [];
  const w = await MeasurementDiagnosticsWriter.create(store, {
    ...base,
    mode: "summary",
    summaryBytes: 8192,
    traceBytes: 0,
    pendingLimitBytes: 2048,
    sink: async (line) => {
      lines.push(line);
    }
  });
  w.record(e);
  await w.flush();
  assert.deepEqual(
    lines
      .map((line) => JSON.parse(line))
      .filter((record) => record.contractVersion === "measurement-stage-aggregate.v1")
      .map((record) => record.count),
    [1]
  );
  w.record(e);
  await w.flush();
  assert.deepEqual(
    lines
      .map((line) => JSON.parse(line))
      .filter((record) => record.contractVersion === "measurement-stage-aggregate.v1")
      .map((record) => record.count),
    [1, 1]
  );
  const stages = [
    "SCHEDULE",
    "INFRASTRUCTURE",
    "DISPATCH",
    "HTTP",
    "NATIVE_CAPTURE",
    "PARSE",
    "PHASE_FILTER",
    "BUFFER_APPEND",
    "EXPOSITION",
    "QUERY",
    "PROJECTION",
    "FINALIZATION",
    "DIAGNOSTIC_WRITE"
  ];
  for (const stage of stages) w.record({ ...e, stage } as any);
  assert.ok(w.snapshot().pendingBytes <= 2048);
  assert.ok(w.snapshot().droppedEvents > 0);
  const result = await w.close();
  assert.equal(result.recordingState, "TRUNCATED");
});

test("structured metadata requires an installed fixed validator and shares queue/working-memory accounting", async (t) => {
  const { store } = await fixture(t);
  const { validateDiagnosticMetadata } =
    await import("../../apps/control-plane/src/measurement-diagnostics/metadata");
  const output: string[] = [];
  const writer = await MeasurementDiagnosticsWriter.create(store, {
    ...base,
    component: "metadata",
    mode: "summary",
    summaryBytes: 8192,
    traceBytes: 0,
    pendingLimitBytes: 2048,
    metadataValidator: validateDiagnosticMetadata,
    sink: async (data) => {
      output.push(data);
    }
  });
  const release = writer.reserveWorkingMemory(1024);
  assert.ok(release);
  assert.equal(writer.reserveWorkingMemory(1025), undefined);
  writer.recordStructured({
    contractVersion: "measurement-publication.v1",
    runId: "run-1",
    summaryAttemptId: null,
    version: "measurement-summary.v1",
    cache: "HIT",
    publicationOutcome: "READY"
  });
  writer.recordStructured({
    contractVersion: "measurement-query-evidence.v1",
    responseBody: "must-not-be-saved"
  });
  release!();
  const terminal = await writer.close();
  assert.equal(terminal.recordingState, "TRUNCATED");
  assert.ok(!output.join("").includes("must-not-be-saved"));
  assert.ok(output.some((line) => JSON.parse(line).record?.cache === "HIT"));
});

test("terminal producer accounting includes the terminal's own bytes and agrees with persisted usage", async (t) => {
  const { root, store } = await fixture(t);
  const writer = await MeasurementDiagnosticsWriter.create(store, {
    ...base,
    mode: "summary",
    summaryBytes: 8192,
    traceBytes: 0
  });
  writer.record(e);
  const terminal = await writer.close();
  const file = path.join(
    root,
    "run-1",
    "measurement-diagnostics",
    "a1",
    "summary",
    `controller-${writer.componentInstanceId}.jsonl`
  );
  const body = await fs.readFile(file, "utf8"),
    footer = JSON.parse(body.trim().split("\n").at(-1)!);
  assert.equal(footer.summaryBytes, Buffer.byteLength(body));
  assert.equal(terminal.summaryBytes, footer.summaryBytes);
  assert.equal((await store.read()).committedSummaryBytes, footer.summaryBytes);
});
test("summary mode preserves qualified skipped ranges and failure identities without counting their aggregate copies twice", async (t) => {
  const { store } = await fixture(t, { summaryLimitBytes: 32768, traceLimitBytes: 0 });
  const { measurementSlotId } =
    await import("../../packages/contracts/src/measurement-diagnostics");
  const writer = await MeasurementDiagnosticsWriter.create(store, {
    ...base,
    mode: "summary",
    summaryBytes: 32768,
    traceBytes: 0
  });
  const slotId = measurementSlotId({
    runId: base.runId,
    diagnosticAttemptId: base.diagnosticAttemptId,
    phase: "measurement",
    observerId: "db",
    slotRuleVersion: "phase-start.v1",
    cadenceMs: 5000,
    ordinal: 2
  });
  writer.record({
    ...e,
    stage: "SCHEDULE",
    outcome: "SKIPPED",
    observerId: "db",
    slotId,
    skippedOrdinalStart: 2,
    skippedOrdinalEnd: 4,
    counts: { skippedSlots: 3 }
  });
  writer.record({ ...e, outcome: "TIMED_OUT", observerId: "db", slotId, httpAttempt: 2 });
  const terminal = await writer.close();
  const lines = (
    await fs.readFile(
      path.join(
        store.directory,
        base.diagnosticAttemptId,
        "summary",
        `controller-${writer.componentInstanceId}.jsonl`
      ),
      "utf8"
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const skipped = lines.find(
    (event) => event.contractVersion === "measurement-observation.v1" && event.outcome === "SKIPPED"
  );
  assert.ok(skipped);
  assert.equal(skipped.slotId, slotId);
  assert.equal(skipped.skippedOrdinalEnd, 4);
  assert.ok(lines.some((event) => event.outcome === "TIMED_OUT" && event.httpAttempt === 2));
  assert.equal(terminal.attemptedEvents, 2);
  assert.equal(terminal.retainedEvents, 2);
  assert.equal(terminal.droppedEvents, 0);
});

test("failed recovery receipts stay charged and uncertain; retries never refund full producer allocations", async (t) => {
  const { store } = await fixture(t, { summaryLimitBytes: 16384, traceLimitBytes: 16384 });
  await store.reserveControl(4096);
  await store.reserve({
    reservationId: "uncertain",
    attemptId: "a1",
    producerId: "native",
    summaryBytes: 1024,
    traceBytes: 4096
  });
  await store.markUnconfirmed();
  const before = await store.read();
  await assert.rejects(
    store.reconcileUncertainReservations(before.revision, 512, async () => {
      throw Error("receipt_failed");
    }),
    /receipt_failed/
  );
  const failed = await store.read();
  assert.equal(failed.accountingState, "UNCONFIRMED");
  assert.equal(failed.committedSummaryBytes, before.committedSummaryBytes + 1536);
  assert.equal(failed.committedTraceBytes, before.committedTraceBytes + 4096);
  await assert.rejects(
    store.reserve({
      reservationId: "new-detail",
      attemptId: "a2",
      producerId: "native",
      summaryBytes: 1024,
      traceBytes: 0
    }),
    /unconfirmed/
  );
  await assert.rejects(
    store.reconcileUncertainReservations(before.revision, 512, async () => {}),
    /conflict/
  );
  assert.deepEqual(await store.read(), failed);
  await store.reconcileUncertainReservations(failed.revision, 512, async () => {});
  const after = await store.read();
  assert.equal(after.accountingState, "CONFIRMED");
  assert.equal(after.committedSummaryBytes, failed.committedSummaryBytes + 512);
  assert.equal(after.committedTraceBytes, failed.committedTraceBytes);
});
