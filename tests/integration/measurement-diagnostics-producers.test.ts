import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MeasurementDiagnosticsService } from "../../apps/control-plane/src/measurement-diagnostics/evidence";
import { MeasurementDiagnosticsWriter } from "../../packages/observers/src/measurement-diagnostics-writer";
import {
  DIAGNOSTIC_DEFAULTS,
  freezeDiagnosticsConfig
} from "../../packages/contracts/src/measurement-diagnostics";
async function fixture(t: any, mode: "summary" | "trace" = "summary") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-producers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifacts: any[] = [];
  const run: any = {
    id: "owned-run",
    experimentId: "owned-experiment",
    variantId: "v",
    repetition: 1,
    environmentSnapshot: {
      resolvedMeasurementDiagnostics: freezeDiagnosticsConfig(
        { contractVersion: "measurement-diagnostics-config.v1", mode },
        DIAGNOSTIC_DEFAULTS,
        0
      ),
      scenario: { observers: [{ kind: "openedge_db_v1" }] }
    }
  };
  const service = new MeasurementDiagnosticsService({
    artifactRoot: root,
    registerArtifact: (a) => {
      artifacts.push(a);
    },
    listArtifacts: () => artifacts
  });
  const session = await service.begin(run);
  return { root, run, session, artifacts };
}
test("seal gathers quiescent native producers from the frozen owned mount before runtime deletion", async (t) => {
  const { session, artifacts } = await fixture(t);
  const config = session.nativeConfigurations["db-observer"];
  const child = await MeasurementDiagnosticsWriter.create(session.store, {
    ...config,
    mode: config.config.mode,
    eventLimitBytes: 4096,
    flushIntervalMs: 1000
  });
  await child.close();
  const result = await session.seal({ terminalState: "FAILED", phaseRefs: [], deployedRefs: {} });
  const producer = result.manifest.producers.find((p) => p.component === "db-observer");
  assert.ok(producer);
  assert.equal(producer.collectionStatus, "COMPLETE");
  assert.equal(producer.summaryBytes, child.snapshot().summaryBytes);
  assert.ok(artifacts.some((a) => a.path.includes(`db-observer-${child.componentInstanceId}`)));
});
test("a declared but absent native producer is explicitly missing and cannot seal complete", async (t) => {
  const { session } = await fixture(t);
  const result = await session.seal({
    terminalState: "CANCELLED",
    phaseRefs: [],
    deployedRefs: {}
  });
  assert.equal(
    result.manifest.producers.find((p) => p.component === "db-observer")?.collectionStatus,
    "MISSING"
  );
  assert.notEqual(result.manifest.recordingState, "SEALED");
});
test("unterminated oversized or unvalidated child data is not registered as downloadable evidence", async (t) => {
  const { session, artifacts } = await fixture(t);
  const directory = path.join(session.store.directory, session.attemptId, "summary");
  const rogue = path.join(directory, "db-observer-00000000-0000-4000-8000-000000000000.jsonl");
  await fs.writeFile(rogue, '{"private_body":"' + "x".repeat(1000000));
  const result = await session.seal({ terminalState: "FAILED", phaseRefs: [], deployedRefs: {} });
  assert.equal(result.manifest.recordingState, "UNAVAILABLE");
  assert.ok(!artifacts.some((a) => a.path.endsWith(path.basename(rogue))));
});
test("an explicit later audit links the original attempt and never configures or restarts native producers", async (t) => {
  const { session, run, root } = await fixture(t);
  const first = await session.seal({ terminalState: "FAILED", phaseRefs: [], deployedRefs: {} }),
    before = await fs.readFile(path.join(root, first.artifact.path));
  const service = (session as any).service as MeasurementDiagnosticsService;
  const audit = await service.begin(run, { audit: true });
  assert.deepEqual(Object.keys(audit.nativeConfigurations), []);
  assert.equal(audit.nativeMount, undefined);
  assert.equal(audit.queryContext(0, 10000).consumer, "AUDIT");
  const result = await audit.seal({ terminalState: "FAILED", phaseRefs: [], deployedRefs: {} });
  assert.equal(result.manifest.parentDiagnosticAttemptId, first.manifest.diagnosticAttemptId);
  assert.deepEqual(await fs.readFile(path.join(root, first.artifact.path)), before);
});
test("missing retained native trace is partial collection even when its terminal byte accounting is known", async (t) => {
  const { session } = await fixture(t, "trace"),
    config = session.nativeConfigurations["db-observer"];
  const child = await MeasurementDiagnosticsWriter.create(session.store, {
    ...config,
    mode: "trace",
    eventLimitBytes: 4096,
    flushIntervalMs: 1000
  });
  child.record({
    stage: "NATIVE_CAPTURE",
    outcome: "SUCCEEDED",
    scheduledAtMs: null,
    startedAtMs: 1000,
    finishedAtMs: 1001,
    sourceCapturedAtMs: 1000,
    availableAtMs: 1001,
    timestampOrigin: "SOURCE",
    durationMs: 1,
    queueWaitMs: 0,
    bodyReadMs: 0,
    callerRole: "UNKNOWN"
  });
  await child.close();
  assert.ok(child.snapshot().traceBytes > 0);
  await fs.unlink(
    path.join(
      session.store.directory,
      session.attemptId,
      "trace",
      `db-observer-${child.componentInstanceId}.jsonl`
    )
  );
  const result = await session.seal({
    terminalState: "SUCCEEDED",
    phaseRefs: [],
    deployedRefs: {}
  });
  assert.equal(result.manifest.recordingState, "UNAVAILABLE");
  assert.equal(
    result.manifest.producers.find((p) => p.component === "db-observer")?.collectionStatus,
    "PARTIAL"
  );
  assert.equal(result.manifest.budgetSnapshot.accountingState, "CONFIRMED");
});
