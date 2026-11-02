import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MeasurementDiagnosticsService } from "../../apps/control-plane/src/measurement-diagnostics/evidence";
import {
  DIAGNOSTIC_DEFAULTS,
  freezeDiagnosticsConfig
} from "../../packages/contracts/src/measurement-diagnostics";
test("diagnostic metadata rejects unknown fields, bounds data, redacts secrets and keeps owned paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-diagnostic-boundaries-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifacts: any[] = [],
    secret = "public-fixture-sensitive-string";
  const service = new MeasurementDiagnosticsService({
    artifactRoot: root,
    secrets: [secret],
    registerArtifact: (artifact) => {
      artifacts.push(artifact);
    },
    listArtifacts: () => artifacts
  });
  const run: any = {
    id: "run-1",
    experimentId: "experiment-1",
    state: "SUCCEEDED",
    measurementValidity: "VALID",
    environmentSnapshot: {
      resolvedMeasurementDiagnostics: freezeDiagnosticsConfig(undefined, DIAGNOSTIC_DEFAULTS, 0),
      scenario: { observers: [] }
    }
  };
  await assert.rejects(() => service.begin({ ...run, id: "../escape" }));
  const session = await service.begin(run);
  session.context("measurement").measurementEvidence.record({
    stage: "HTTP",
    outcome: "FAILED",
    scheduledAtMs: null,
    startedAtMs: null,
    finishedAtMs: null,
    sourceCapturedAtMs: null,
    availableAtMs: null,
    timestampOrigin: "UNKNOWN",
    durationMs: 0,
    queueWaitMs: 0,
    bodyReadMs: 0,
    callerRole: "UNKNOWN",
    reasonCodes: [secret]
  });
  session.recordMetadata({
    contractVersion: "measurement-query-evidence.v1",
    responseBody: secret
  });
  const result = await session.seal({
    terminalState: "SUCCEEDED",
    phaseRefs: [],
    deployedRefs: {}
  });
  assert.ok(["TRUNCATED", "UNAVAILABLE"].includes(result.manifest.recordingState));
  for (const artifact of artifacts) {
    const file = path.resolve(root, artifact.path);
    assert.ok(file.startsWith(root + path.sep));
    assert.ok(!(await fs.readFile(file, "utf8")).includes(secret));
  }
  assert.equal(run.measurementValidity, "VALID");
});

test("evidence writes reject a symlinked page directory before creating files outside the owned attempt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-diagnostic-symlink-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifacts: any[] = [];
  const service = new MeasurementDiagnosticsService({
    artifactRoot: root,
    registerArtifact: (a) => {
      artifacts.push(a);
    },
    listArtifacts: () => artifacts
  });
  const run: any = {
    id: "run-1",
    experimentId: "experiment-1",
    state: "SUCCEEDED",
    measurementValidity: "VALID",
    environmentSnapshot: {
      resolvedMeasurementDiagnostics: freezeDiagnosticsConfig(undefined, DIAGNOSTIC_DEFAULTS, 0),
      scenario: { observers: [] }
    }
  };
  const session = await service.begin(run),
    outside = path.join(root, "unrelated");
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(session.store.directory, session.attemptId, "inventory"),
    "dir"
  );
  session.recordMetadata({
    contractVersion: "measurement-path-inventory.v1",
    runId: "run-1",
    observerId: "files",
    pathRef: "owned-path",
    kind: "directory",
    capturedAtMs: 1
  });
  await assert.rejects(
    () => session.seal({ terminalState: "SUCCEEDED", phaseRefs: [], deployedRefs: {} }),
    /symlink/
  );
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(run.measurementValidity, "VALID");
  assert.equal((await service.read(run)).recordingState, "UNAVAILABLE");
});
test("diagnostic download validation rejects symlink swaps, changed sizes and cross-attempt paths", async (t) => {
  const { diagnosticDownloadPath } =
    await import("../../apps/control-plane/src/measurement-diagnostics/producer-files");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-download-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const relative = "run-1/measurement-diagnostics/attempt-1/manifest.json",
    file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{}");
  const artifact: any = {
    runId: "run-1",
    kind: "diagnostics",
    path: relative,
    sizeBytes: 2,
    sourceMetadata: {
      contractVersion: "measurement-diagnostics.v1",
      attemptId: "attempt-1",
      role: "manifest"
    }
  };
  assert.equal(await diagnosticDownloadPath(root, artifact), file);
  await assert.rejects(() =>
    diagnosticDownloadPath(root, {
      ...artifact,
      sourceMetadata: { ...artifact.sourceMetadata, attemptId: "attempt-2" }
    })
  );
  await fs.writeFile(file, "changed");
  await assert.rejects(() => diagnosticDownloadPath(root, artifact));
  const outside = path.join(root, "outside");
  await fs.writeFile(outside, "{}");
  await fs.unlink(file);
  await fs.symlink(outside, file);
  await assert.rejects(() => diagnosticDownloadPath(root, artifact));
});
test("fixed metadata counters cannot be used to retain raw measurement values", async () => {
  const { validateDiagnosticMetadata } =
    await import("../../apps/control-plane/src/measurement-diagnostics/metadata");
  const record = {
    contractVersion: "measurement-statistics-decision.v1",
    startMs: 0,
    endMs: 10000,
    cadenceMs: 5000,
    physicalId: null,
    storedObservations: 2,
    reasonCodes: [],
    counts: {
      resetIntervals: 0,
      epochTransitionIntervals: 0,
      duplicateTimestamps: 0,
      conflictingTimestamps: 0,
      gapIntervals: 0
    }
  };
  assert.doesNotThrow(() => validateDiagnosticMetadata(record));
  assert.throws(() => validateDiagnosticMetadata({ ...record, counts: { value: 123 } }));
  assert.throws(() => validateDiagnosticMetadata({ ...record, counts: { observedTotal: 123 } }));
});
test("consolidation validates the complete metadata producer before registering any derived download", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-metadata-spool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifacts: any[] = [],
    secret = "unvalidated-fixture-response";
  const service = new MeasurementDiagnosticsService({
    artifactRoot: root,
    registerArtifact: (a) => {
      artifacts.push(a);
    },
    listArtifacts: () => artifacts
  });
  const run: any = {
    id: "run-1",
    experimentId: "experiment-1",
    environmentSnapshot: {
      resolvedMeasurementDiagnostics: freezeDiagnosticsConfig(undefined, DIAGNOSTIC_DEFAULTS, 0),
      scenario: { observers: [] }
    }
  };
  const session = await service.begin(run);
  const file = path.join(
    session.store.directory,
    session.attemptId,
    "summary",
    `metadata-${session.metadata.componentInstanceId}.jsonl`
  );
  let injected = false;
  (session.metadata as any).options.sink = async (line: string) => {
    await fs.appendFile(file, line);
    if (!injected && line.includes('"measurement-evidence-record.v1"')) {
      injected = true;
      await fs.appendFile(
        file,
        JSON.stringify({
          contractVersion: "measurement-evidence-record.v1",
          eventId: "rogue",
          runId: run.id,
          diagnosticAttemptId: session.attemptId,
          componentInstanceId: session.metadata.componentInstanceId,
          sequence: 999,
          record: { contractVersion: "measurement-query-selector.v1", privateResponse: secret }
        }) + "\n"
      );
    }
  };
  session.recordMetadata({
    contractVersion: "measurement-path-inventory.v1",
    runId: run.id,
    observerId: "files",
    pathRef: "owned-path",
    kind: "directory",
    capturedAtMs: 1
  });
  await session.metadata.flush();
  const result = await session.seal({ terminalState: "FAILED", phaseRefs: [], deployedRefs: {} });
  assert.equal(result.manifest.recordingState, "UNAVAILABLE");
  for (const artifact of artifacts)
    assert.ok(!(await fs.readFile(path.join(root, artifact.path), "utf8")).includes(secret));
});
