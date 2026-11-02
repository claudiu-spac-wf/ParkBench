import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MeasurementTraceRetention } from "../../apps/control-plane/src/measurement-diagnostics/retention";
import { DiagnosticBudgetStore } from "../../packages/observers/src/measurement-diagnostics-writer";
import {
  freezeDiagnosticsConfig,
  DIAGNOSTIC_DEFAULTS
} from "../../packages/contracts/src/measurement-diagnostics";
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-retention-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = freezeDiagnosticsConfig(
    { contractVersion: "measurement-diagnostics-config.v1", mode: "trace" },
    DIAGNOSTIC_DEFAULTS,
    0
  );
  const store = await DiagnosticBudgetStore.open(root, "run-1", config);
  const run: any = {
    id: "run-1",
    environmentSnapshot: {
      resolvedMeasurementDiagnostics: config,
      measurementDiagnosticsEvidence: {
        attemptId: "attempt-1",
        runBudgetId: (await store.read()).runBudgetId
      }
    }
  };
  const relative = "run-1/measurement-diagnostics/attempt-1/trace/db-observer-instance.jsonl";
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), "owned fixture trace\n");
  const artifacts: any[] = [
    {
      id: "trace-1",
      runId: run.id,
      kind: "diagnostics",
      path: relative,
      sizeBytes: 20,
      createdAt: new Date(0).toISOString(),
      sourceMetadata: {
        contractVersion: "measurement-diagnostics.v1",
        attemptId: "attempt-1",
        role: "trace"
      }
    }
  ];
  const retention = new MeasurementTraceRetention({
    artifactRoot: root,
    run: (id) => (id === run.id ? run : undefined),
    listArtifacts: (id) => artifacts.filter((a) => a.runId === id),
    allTraceArtifacts: () => artifacts.filter((a) => a.sourceMetadata?.role === "trace"),
    registerArtifact: (a) => {
      artifacts.push(a);
    },
    isIdle: () => true
  });
  return { root, store, run, artifacts, retention, target: artifacts[0] };
}
test("pins protect open evidence; confirmed expiry appends intent/completion and never refunds committed usage", async (t) => {
  const { retention, target, artifacts, root, store } = await fixture(t);
  const snapshot = JSON.stringify(target);
  await retention.pin(target, "finding-1");
  await assert.rejects(() => retention.expire(target, "detail_ttl_elapsed"), /pinned/);
  assert.equal((await retention.project(target)).availability, "AVAILABLE");
  await retention.unpin(target, "finding-1");
  const before = await store.read();
  await retention.expire(target, "detail_ttl_elapsed");
  assert.equal((await retention.project(target)).availability, "EXPIRED");
  assert.equal(JSON.stringify(target), snapshot);
  assert.ok((await store.read()).committedSummaryBytes > before.committedSummaryBytes);
  assert.deepEqual(
    (await retention.events(target.runId)).map((e) => e.action),
    ["PIN", "UNPIN", "EXPIRE_REQUESTED", "EXPIRED"]
  );
  assert.equal(artifacts.filter((a) => a.sourceMetadata?.role === "retention-event").length, 4);
  await assert.rejects(() => fs.stat(path.join(root, target.path)), /ENOENT/);
});
test("unexplained loss is unavailable; retention budget/write failures preserve existing detail", async (t) => {
  const { retention, target, root, store } = await fixture(t);
  await fs.unlink(path.join(root, target.path));
  assert.equal((await retention.project(target)).availability, "UNAVAILABLE");
  await fs.writeFile(path.join(root, target.path), "preserve");
  const budget = await store.read(),
    control = budget.reservations.find((r) => r.reservationId === "retention-control")!;
  await store.charge(control.reservationId, control.summaryBytes);
  await assert.rejects(() => retention.expire(target, "detail_ttl_elapsed"), /budget/);
  assert.equal(await fs.readFile(path.join(root, target.path), "utf8"), "preserve");
});
test("capacity/TTL sweep preserves pins, rejects the next batch and touches only owned trace artifacts", async (t) => {
  const { retention, target, root } = await fixture(t);
  await retention.pin(target, "finding-1");
  await assert.rejects(
    () => retention.prepareBatch({ nowMs: 8 * 86400000, limitBytes: 20, requestedBytes: 1 }),
    /capacity/
  );
  assert.ok(await fs.stat(path.join(root, target.path)));
  await retention.unpin(target, "finding-1");
  await retention.prepareBatch({ nowMs: 8 * 86400000, limitBytes: 20, requestedBytes: 1 });
  assert.equal((await retention.project(target)).availability, "EXPIRED");
});
test("resolving one finding cannot remove another finding's pin", async (t) => {
  const { retention, target } = await fixture(t);
  await retention.pin(target, "finding-1");
  await retention.pin(target, "finding-2");
  await retention.unpin(target, "finding-1");
  assert.equal((await retention.project(target)).pinned, true);
  await assert.rejects(() => retention.expire(target, "detail_ttl_elapsed"), /pinned/);
});
test("a failed completion receipt restores the trace and leaves expiry unconfirmed", async (t) => {
  const { retention, target, root } = await fixture(t);
  let calls = 0;
  const register = retention.options.registerArtifact;
  retention.options.registerArtifact = (a) => {
    if (++calls === 2) throw new Error("fixture_journal_registration_failed");
    register(a);
  };
  await assert.rejects(() => retention.expire(target, "detail_ttl_elapsed"));
  assert.equal(await fs.readFile(path.join(root, target.path), "utf8"), "owned fixture trace\n");
  assert.equal((await retention.project(target)).availability, "UNAVAILABLE");
});
test("batch admission pins trace for retained open findings before applying TTL", async (t) => {
  const { retention, target, root, artifacts } = await fixture(t);
  const relative = "run-1/measurement-diagnostics/attempt-1/findings/00000.json";
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  const finding = {
    contractVersion: "measurement-finding.v1",
    findingId: "finding-open",
    runId: "run-1",
    expectationId: "expectation-1",
    symptom: "missing_native",
    startMs: 0,
    endMs: 10000,
    lastConfirmedStage: null,
    classification: "UNRESOLVED",
    reasonCode: "source_evidence_pending",
    evidenceRefs: [],
    hypothesisIds: [],
    state: "OPEN",
    coverage: {},
    missingMemberIds: [],
    nativeAvailability: null
  };
  await fs.writeFile(path.join(root, relative), JSON.stringify([{ record: finding }]));
  artifacts.push({
    id: "findings-1",
    runId: "run-1",
    kind: "diagnostics",
    path: relative,
    sourceMetadata: {
      contractVersion: "measurement-diagnostics.v1",
      attemptId: "attempt-1",
      role: "findings"
    }
  });
  await assert.rejects(
    () => retention.prepareBatch({ nowMs: 8 * 86400000, limitBytes: 20, requestedBytes: 1 }),
    /capacity/
  );
  assert.equal((await retention.project(target)).pinned, true);
  assert.equal((await retention.events("run-1")).length, 1);
  await retention.prepareBatch({ nowMs: 8 * 86400000, limitBytes: 20, requestedBytes: 0 });
  assert.equal((await retention.events("run-1")).length, 1);
  assert.ok(await fs.stat(path.join(root, target.path)));
});
test("uncertain producer budgets block new batches before any expiry or pin mutation", async (t) => {
  const { retention, target, root, store } = await fixture(t);
  await store.markUnconfirmed();
  await assert.rejects(
    () => retention.prepareBatch({ nowMs: 8 * 86400000, requestedBytes: 1 }),
    /budget_unavailable/
  );
  assert.ok(await fs.stat(path.join(root, target.path)));
  assert.equal((await retention.events("run-1")).length, 0);
});

async function openFindingPage(root: string, artifacts: any[], count: number) {
  const relative = "run-1/measurement-diagnostics/attempt-1/findings/open-page.json";
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  const records = Array.from({ length: count }, (_, i) => ({
    record: {
      contractVersion: "measurement-finding.v1",
      findingId: `open-${i}`,
      runId: "run-1",
      expectationId: `expectation-${i}`,
      symptom: "missing_native",
      startMs: 0,
      endMs: 10000,
      lastConfirmedStage: null,
      classification: "UNRESOLVED",
      reasonCode: "source_evidence_pending",
      evidenceRefs: [],
      hypothesisIds: [],
      state: "OPEN",
      coverage: {},
      missingMemberIds: [],
      nativeAvailability: null
    }
  }));
  await fs.writeFile(path.join(root, relative), JSON.stringify(records));
  artifacts.push({
    id: "findings-many",
    runId: "run-1",
    kind: "diagnostics",
    path: relative,
    sourceMetadata: {
      contractVersion: "measurement-diagnostics.v1",
      attemptId: "attempt-1",
      role: "findings"
    }
  });
}
test("many open findings protect shared trace without a per-finding journal fan-out", async (t) => {
  const { retention, target, root, artifacts } = await fixture(t);
  await openFindingPage(root, artifacts, 90);
  await retention.prepareBatch({ requestedBytes: 1 });
  assert.equal((await retention.events("run-1")).length, 1);
  await retention.unpin(target, "open-0");
  assert.equal(
    (await retention.project(target)).pinned,
    true,
    "another unresolved finding must retain protection"
  );
  await assert.rejects(() => retention.expire(target, "detail_ttl_elapsed"), /pinned/);
  assert.ok(await fs.stat(path.join(root, target.path)));
});
test("already protected trace admits the next batch without refilling an exhausted journal reservation", async (t) => {
  const { retention, target, root, artifacts, store } = await fixture(t);
  await openFindingPage(root, artifacts, 90);
  await retention.pin(target, "open-0");
  const budget = await store.read();
  await store.charge(
    "retention-control",
    budget.reservations.find((r) => r.reservationId === "retention-control")!.summaryBytes
  );
  const before = await store.read();
  await retention.prepareBatch({ requestedBytes: 1 });
  assert.deepEqual(await store.read(), before);
  assert.equal((await retention.events("run-1")).length, 1);
  assert.equal((await retention.project(target)).pinned, true);
});

test("conservative recovered trace charges remain in the global bound even without downloadable producer files", async (t) => {
  const { store, retention } = await fixture(t);
  await store.reserve({
    reservationId: "killed",
    attemptId: "attempt-1",
    producerId: "native",
    summaryBytes: 1024,
    traceBytes: 512
  });
  await store.markUnconfirmed();
  await store.reconcileUncertainReservations((await store.read()).revision, 256, async () => {});
  await assert.rejects(
    retention.prepareBatch({ nowMs: 0, limitBytes: 511, requestedBytes: 1 }),
    /capacity/
  );
  const result = await retention.prepareBatch({ nowMs: 0, limitBytes: 513, requestedBytes: 1 });
  assert.equal(result.retainedBytes, 512);
  assert.equal(result.unindexedTraceBytes, 492);
  assert.equal((await store.read()).committedTraceBytes, 512);
});
