import test from "node:test";
import { createServer } from "node:http";
import { HttpPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import { measurementStatistics } from "../../packages/metrics/src/measurement-statistics";
import { observerLabels } from "../../packages/observers/src/adapter";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MeasurementDiagnosticsService } from "../../apps/control-plane/src/measurement-diagnostics/evidence";
import {
  DIAGNOSTIC_DEFAULTS,
  freezeDiagnosticsConfig
} from "../../packages/contracts/src/measurement-diagnostics";
import { DiagnosticBudgetStore } from "../../packages/observers/src/measurement-diagnostics-writer";
const event = {
  stage: "HTTP" as const,
  outcome: "SUCCEEDED" as const,
  scheduledAtMs: 1000,
  startedAtMs: 1000,
  finishedAtMs: 1001,
  sourceCapturedAtMs: null,
  availableAtMs: 1001,
  timestampOrigin: "UNKNOWN" as const,
  durationMs: 1,
  queueWaitMs: 0,
  bodyReadMs: 0,
  callerRole: "CONTROLLER" as const
};
function run(mode: "summary" | "trace" = "summary", settings = DIAGNOSTIC_DEFAULTS): any {
  return {
    id: "run-1",
    experimentId: "experiment-1",
    variantId: "v",
    repetition: 1,
    state: "SUCCEEDED",
    measurementValidity: "VALID",
    cleanupStatus: "COMPLETE",
    environmentSnapshot: {
      measurementDiagnostics: { contractVersion: "measurement-diagnostics-config.v1", mode },
      resolvedMeasurementDiagnostics: freezeDiagnosticsConfig(
        { contractVersion: "measurement-diagnostics-config.v1", mode },
        settings,
        0
      ),
      scenario: { observers: [] }
    }
  };
}
const expectation = {
  contractVersion: "measurement-expectation.v1",
  expectationId: "expectation-1",
  runId: "run-1",
  definitionId: "public_metric",
  semanticVersion: "1",
  statistic: "source_reading",
  scope: "controller",
  dimensions: {},
  sourceKind: "controller",
  publisher: "controller",
  phase: "measurement",
  startMs: 1000,
  endMs: 11000,
  sourceCadenceMs: 5000,
  controllerCadenceMs: 5000,
  scrapeCadenceMs: 5000,
  qualityRequirement: "required",
  applicability: "EXPECTED",
  applicabilityReason: null,
  evidenceRefs: [],
  slotRuleVersion: "phase-start.v1",
  expectedSlots: 2,
  consumingViews: []
};
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-history-diagnostics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifacts: any[] = [];
  const service = new MeasurementDiagnosticsService({
    artifactRoot: root,
    registerArtifact: (a) => {
      artifacts.push(a);
    },
    listArtifacts: (runId) => artifacts.filter((a) => a.runId === runId)
  });
  return { root, artifacts, service };
}
test("sealed diagnostics survive runtime/source deletion and a new service instance; reads never rewrite manifests", async (t) => {
  const { root, artifacts, service } = await fixture(t),
    source = run();
  const quality = { state: source.state, measurementValidity: source.measurementValidity };
  const session = await service.begin(source);
  await session.setExpectations([expectation]);
  session.context("measurement").measurementEvidence.record(event);
  const result = await session.seal({
    terminalState: "SUCCEEDED",
    phaseRefs: ["phase-1"],
    deployedRefs: { controller: "image-1" }
  });
  assert.equal(result.manifest.recordingState, "SEALED");
  assert.ok(
    artifacts.some((a) => a.kind === "diagnostics" && a.sourceMetadata?.role === "manifest")
  );
  const file = path.join(root, result.artifact.path),
    before = await fs.readFile(file);
  const budget = await session.store.read();
  assert.equal(result.manifest.budgetSnapshot.committedSummaryBytes, budget.committedSummaryBytes);
  assert.equal(result.manifest.summaryBytes, budget.committedSummaryBytes);
  assert.ok(
    budget.committedSummaryBytes >=
      before.byteLength + result.manifest.producers.reduce((n, p) => n + p.summaryBytes, 0)
  );
  assert.ok(!budget.reservations.some((r) => r.producerId === "manifest"));
  const runtime = path.join(root, "runtime");
  await fs.mkdir(runtime);
  await fs.writeFile(path.join(runtime, "native-source"), "transient");
  await fs.rm(runtime, { recursive: true });
  const reopened = new MeasurementDiagnosticsService({
    artifactRoot: root,
    registerArtifact: () => {
      throw new Error("GET attempted a write");
    },
    listArtifacts: () => artifacts
  });
  const read = await reopened.read(source);
  assert.equal(read.recordingState, "SEALED");
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(
    { state: source.state, measurementValidity: source.measurementValidity },
    quality
  );
});
test("cancelled/failed/interrupted recording retains evidence independently of real measurement quality", async (t) => {
  const { service } = await fixture(t),
    source = run();
  source.state = "CANCELLED";
  source.measurementValidity = "UNAVAILABLE";
  const session = await service.begin(source);
  await session.setExpectations([expectation]);
  session.context("measurement").measurementEvidence.record({ ...event, outcome: "CANCELLED" });
  const result = await session.seal({
    terminalState: "CANCELLED",
    phaseRefs: ["phase-interrupted"],
    deployedRefs: {}
  });
  assert.ok(["SEALED", "INTERRUPTED"].includes(result.manifest.recordingState));
  assert.equal(source.state, "CANCELLED");
  assert.equal(source.measurementValidity, "UNAVAILABLE");
  const legacy = { ...run(), id: "legacy", environmentSnapshot: {} };
  assert.equal((await service.read(legacy)).recordingState, "NOT_RECORDED");
  const pending = run();
  pending.environmentSnapshot.measurementDiagnosticsEvidence = {
    attemptId: "missing-attempt",
    recordingState: "RECORDING"
  };
  assert.equal((await service.read(pending)).recordingState, "UNAVAILABLE");
});
test("later audits consume only remaining original ceilings and never overwrite earlier attempts", async (t) => {
  const { service, root } = await fixture(t);
  const settings = { ...DIAGNOSTIC_DEFAULTS, summaryLimitBytes: 262144, traceLimitBytes: 4096 };
  const source = run("trace", settings),
    session = await service.begin(source);
  await session.setExpectations([expectation]);
  session.context("measurement").measurementEvidence.record(event);
  const first = await session.seal({ terminalState: "SUCCEEDED", phaseRefs: [], deployedRefs: {} });
  const original = await fs.readFile(path.join(root, first.artifact.path));
  let exhausted = false,
    acceptedAudits = 0;
  for (let n = 0; n < 12; n++) {
    try {
      const audit = await service.begin(source, { audit: true });
      await audit.setExpectations([expectation]);
      audit.context("measurement").measurementEvidence.record(event);
      await audit.seal({ terminalState: "SUCCEEDED", phaseRefs: [], deployedRefs: {} });
      acceptedAudits++;
    } catch (error) {
      assert.match(String(error), /budget|allowance|exhausted/i);
      exhausted = true;
      break;
    }
  }
  assert.equal(exhausted, true);
  assert.ok(acceptedAudits < 12);
  assert.deepEqual(await fs.readFile(path.join(root, first.artifact.path)), original);
  const store = await DiagnosticBudgetStore.open(root, source.id, settings),
    budget = await store.read();
  assert.equal(budget.summaryLimitBytes, 262144);
  assert.equal(budget.traceLimitBytes, 4096);
  assert.ok(budget.committedTraceBytes > 0 && budget.committedTraceBytes <= 4096);
  await assert.rejects(() =>
    DiagnosticBudgetStore.open(root, source.id, { ...settings, traceLimitBytes: 8192 })
  );
});
test("failed diagnostic writes retain an UNAVAILABLE manifest without changing benchmark validity or refilling uncertain budgets", async (t) => {
  const { service } = await fixture(t),
    source = run(),
    session = await service.begin(source);
  await session.setExpectations([expectation]);
  (session.controller as any).options.sink = async () => {
    throw new Error("private sink failure");
  };
  session.context("measurement").measurementEvidence.record(event);
  const result = await session.seal({
    terminalState: "SUCCEEDED",
    phaseRefs: [],
    deployedRefs: {}
  });
  assert.equal(result.manifest.recordingState, "UNAVAILABLE");
  assert.equal(result.manifest.budgetSnapshot.accountingState, "UNCONFIRMED");
  assert.equal(source.measurementValidity, "VALID");
  await assert.rejects(() => service.begin(source, { audit: true }), /unconfirmed|budget/);
});
test("restart recovery uses the frozen attempt and remaining ledger, without replaying workload or setup", async (t) => {
  const { root, service } = await fixture(t),
    source = run();
  const { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util");
  const childCode = `(async()=>{const fs=require('node:fs/promises');const {MeasurementDiagnosticsService}=require('./apps/control-plane/src/measurement-diagnostics/evidence.ts');const run=JSON.parse(process.env.DIAGNOSTIC_FIXTURE_RUN);const s=new MeasurementDiagnosticsService({artifactRoot:process.env.DIAGNOSTIC_FIXTURE_ROOT,registerArtifact:()=>{},listArtifacts:()=>[]});const a=await s.begin(run);a.context('measurement').measurementEvidence.record(${JSON.stringify(event)});await a.controller.flush();await a.metadata.flush();await fs.writeFile(process.env.DIAGNOSTIC_FIXTURE_ROOT+'/checkpoint.json',JSON.stringify(run));process.exit(0)})().catch(()=>process.exit(1))`;
  await promisify(execFile)(process.execPath, ["--import", "tsx", "-e", childCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DIAGNOSTIC_FIXTURE_ROOT: root,
      DIAGNOSTIC_FIXTURE_RUN: JSON.stringify(source)
    }
  });
  const interrupted = JSON.parse(await fs.readFile(path.join(root, "checkpoint.json"), "utf8"));
  const before = await DiagnosticBudgetStore.open(
    root,
    source.id,
    interrupted.environmentSnapshot.resolvedMeasurementDiagnostics
  );
  const budgetId = (await before.read()).runBudgetId;
  let quiesceCalls = 0;
  const recovered = await service.recover(interrupted, async () => {
    quiesceCalls++;
  });
  assert.equal(quiesceCalls, 1);
  assert.equal(recovered.recordingState, "UNAVAILABLE");
  assert.ok(recovered.manifest);
  assert.equal(
    recovered.manifest.diagnosticAttemptId,
    interrupted.environmentSnapshot.measurementDiagnosticsEvidence.attemptId
  );
  assert.equal(recovered.manifest.runBudgetId, budgetId);
  assert.equal(recovered.manifest.budgetSnapshot.accountingState, "UNCONFIRMED");
  const after = await before.read();
  assert.ok(after.reservations.some((r) => r.producerId.startsWith("controller-")));
  const bytes = await fs.readFile(
    path.join(
      root,
      service.options.listArtifacts(source.id).find((a) => a.sourceMetadata?.role === "manifest")!
        .path
    )
  );
  await service.recover(interrupted, async () => {
    throw new Error("sealed recovery must be read only");
  });
  assert.deepEqual(
    await fs.readFile(
      path.join(
        root,
        service.options.listArtifacts(source.id).find((a) => a.sourceMetadata?.role === "manifest")!
          .path
      )
    ),
    bytes
  );
});
test("retained findings keep exact statistic/scope reasons and independent path limitations beside healthy siblings", async (t) => {
  const { service, root } = await fixture(t),
    source = run(),
    session = await service.begin(source);
  const projection = {
    contractVersion: "measurement-projection.v1",
    projectionStage: "CALCULATED",
    definitionId: "disk.read.bytes",
    group: "platform",
    dimensions: {},
    statistic: "avg",
    status: "partial",
    reasonCodes: ["insufficient_data"],
    supportedSeconds: 5,
    estimatedSeconds: 0,
    missingSeconds: 5,
    availableBins: 1,
    omittedBins: 1,
    expectedAcquisitions: 2,
    observedAcquisitions: 1,
    minimumPercentileBins: 2,
    sourceReferences: [{ metric: "public_counter", contractVersion: "measurement-summary.v1" }]
  };
  session.recordMetadata(projection);
  await session.setExpectations([
    {
      ...expectation,
      expectationId: "partial-platform",
      definitionId: "disk.read.bytes",
      statistic: "avg",
      scope: "platform:resource",
      dimensions: { scope: "platform" }
    },
    {
      ...expectation,
      expectationId: "healthy-database",
      definitionId: "disk.read.bytes",
      statistic: "avg",
      scope: "database:resource",
      dimensions: { scope: "database" }
    },
    {
      ...expectation,
      expectationId: "directory-size",
      definitionId: "disk.space.file_size",
      statistic: "value",
      applicability: "UNSUPPORTED",
      applicabilityReason: "path_kind_directory",
      evidenceRefs: ["independent-stat-proof"]
    }
  ]);
  const result = await session.seal({
    terminalState: "SUCCEEDED",
    phaseRefs: [],
    deployedRefs: {}
  });
  const findings = [];
  for (const id of result.manifest.findingPages) {
    const a = service.options.listArtifacts(source.id).find((a) => a.id === id)!;
    findings.push(
      ...JSON.parse(await fs.readFile(path.join(root, a.path), "utf8")).map(
        (record: any) => record.record
      )
    );
  }
  assert.equal(findings.length, 2);
  assert.equal(
    findings.find((f) => f.expectationId === "partial-platform").classification,
    "UNRESOLVED"
  );
  assert.equal(
    findings.find((f) => f.expectationId === "partial-platform").coverage.missingSeconds,
    5
  );
  assert.equal(
    findings.find((f) => f.expectationId === "directory-size").classification,
    "LEGITIMATE_LIMITATION"
  );
  assert.ok(!findings.some((f) => f.expectationId === "healthy-database"));
  assert.equal(source.measurementValidity, "VALID");
});
test("query-derived findings identify the independently missing physical member and preserve healthy zero-valued siblings", async (t) => {
  const { service, root } = await fixture(t),
    source = run(),
    session = await service.begin(source);
  session.setTopology([
    { group: "platform", service: "control-plane", memberId: "cp", imageId: "public-image-cp" },
    { group: "platform", service: "web", memberId: "web", imageId: "public-image-web" }
  ]);
  const { withQueryEvidence } = await import("../../packages/metrics/src/query-evidence"),
    { HttpPrometheusClient } = await import("../../packages/metrics/src/prometheus-client");
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: { __name__: "container_fs_reads_bytes_total", job: "cadvisor", id: "web" },
              values: [
                [0, "0"],
                [5, "0"]
              ]
            }
          ]
        }
      })
    )) as any;
  try {
    await withQueryEvidence(
      {
        ...session.queryContext(0, 10000),
        source: "cadvisor",
        definitionId: "disk.read.bytes",
        expectedMemberIds: ["cp", "web"]
      },
      () =>
        new HttpPrometheusClient("http://fixture").queryRawRange(
          'container_fs_reads_bytes_total{job="cadvisor"}',
          0,
          10,
          5
        )
    );
  } finally {
    globalThis.fetch = original;
  }
  const common = {
    ...expectation,
    definitionId: "disk.read.bytes",
    scope: "platform:resource",
    startMs: 0,
    endMs: 10000
  };
  await session.setExpectations([
    { ...common, expectationId: "platform-total", dimensions: { scope: "platform" } },
    {
      ...common,
      expectationId: "cp-member",
      dimensions: { member: "cp", service: "control-plane" }
    },
    { ...common, expectationId: "web-member", dimensions: { member: "web", service: "web" } }
  ]);
  const result = await session.seal({
      terminalState: "SUCCEEDED",
      phaseRefs: [],
      deployedRefs: {}
    }),
    findings: any[] = [];
  for (const id of result.manifest.findingPages) {
    const a = service.options.listArtifacts(source.id).find((a) => a.id === id)!;
    findings.push(
      ...JSON.parse(await fs.readFile(path.join(root, a.path), "utf8")).map(
        (record: any) => record.record
      )
    );
  }
  assert.equal(findings.length, 2);
  assert.ok(
    findings.every(
      (f) => f.reasonCode === "required_member_missing" && f.missingMemberIds.join() === "cp"
    )
  );
  assert.ok(!findings.some((f) => f.expectationId === "web-member"));
  assert.equal(source.measurementValidity, "VALID");
});

test("streamed summary finalization retains every table's diagnostic projection within the original pending ceiling", async (t) => {
  const { root, service } = await fixture(t);
  const { DatabaseClient } = await import("../../apps/control-plane/src/db/client");
  const { Repositories } = await import("../../apps/control-plane/src/db/repositories");
  const { ArtifactStorage } = await import("../../apps/control-plane/src/artifacts/storage");
  const { ComparisonSummaryService } =
    await import("../../apps/control-plane/src/runs/comparison-summary-service");
  const { MemoryPrometheusClient } = await import("../../packages/metrics/src/prometheus-client");
  const { withQueryEvidence } = await import("../../packages/metrics/src/query-evidence");
  const source = run();
  source.composeProject = source.id;
  source.resourceNamespace = {};
  source.environmentSnapshot.scenario.observers = [
    "openedge_db_v1",
    "openedge_pas_v1",
    "file_sampler_v1"
  ].map((kind) => ({ kind }));
  source.phaseBoundaries = {
    measurement: {
      startedAt: new Date(1000).toISOString(),
      finishedAt: new Date(16000).toISOString()
    }
  };
  const db = new DatabaseClient();
  t.after(() => db.close());
  const migrations = await fs.readdir("apps/control-plane/src/db/migrations");
  db.migrate(
    (
      await Promise.all(
        migrations
          .filter((p) => p.endsWith(".sql"))
          .sort()
          .map((p) => fs.readFile(path.join("apps/control-plane/src/db/migrations", p), "utf8"))
      )
    ).join("\n")
  );
  const repositories = new Repositories(db);
  repositories.saveRun(source);
  const samples: any[] = [];
  for (let n = 0; n < 40; n++)
    for (const operation of ["read", "create", "update", "delete"]) {
      const labels = {
        run_id: source.id,
        job: "parkbench-runs",
        table: `PublicTable${n}`,
        operation,
        measurement: "table_operations_total"
      };
      samples.push({
        metricName: "parkbench_openedge_db_metric_available",
        type: "gauge",
        labels,
        timestamp: 12,
        value: 1,
        source: "public-fixture"
      });
      for (const timestamp of [1, 6, 11])
        samples.push({
          metricName: "parkbench_openedge_db_table_operations_total",
          type: "counter",
          labels,
          timestamp,
          value: timestamp,
          source: "public-fixture"
        });
    }
  const session = await service.begin(source);
  const summary = new ComparisonSummaryService(
    repositories,
    new ArtifactStorage(root),
    new MemoryPrometheusClient(samples)
  );
  const prepared = await withQueryEvidence(session.queryContext(1000, 16000), () =>
    summary.prepare(source, { origin: "historical_recompute" })
  );
  prepared.releaseLease?.();
  assert.ok(
    prepared.header.tableRowCount >= 200,
    "all 40 independent names retain every table summary row"
  );
  const snapshot = session.metadata.snapshot();
  await session.controller.close();
  await session.metadata.close();
  assert.equal(
    snapshot.droppedEvents,
    0,
    "finalization must drain metadata between yielded rows rather than drop bursts"
  );
  assert.equal(snapshot.droppedMetadataRecords, 0);
});

test("a native inventory larger than one equal producer share fits the unchanged combined pending ceiling", async (t) => {
  const { service } = await fixture(t),
    source = run();
  source.environmentSnapshot.scenario.observers = [
    "openedge_db_v1",
    "openedge_pas_v1",
    "file_sampler_v1"
  ].map((kind) => ({ kind }));
  const session = await service.begin(source);
  const epoch = JSON.stringify(["Fri Oct 30 19:54:27 2026", "2026-10-30T19:54:27.123+00:00"]);
  const availability = Array.from({ length: 1000 }, (_, n) => ({
    metricName: "parkbench_openedge_db_latch_named_waits_total",
    dimensions: {
      database: "public-fixture",
      database_epoch: epoch,
      latch_name: `PublicLatch${n}`,
      latch_type: "spin",
      latch_id: String(n)
    },
    availability: "available",
    reasonCode: "observed",
    sourceRef: "_Latch._Latch-Waits"
  }));
  const input = {
    contractVersion: "measurement-native-inventory.v1",
    evidenceId: "public-inventory",
    runId: source.id,
    capturedAtMs: 1000,
    dimensions: {
      database: ["public-fixture"],
      database_epoch: [epoch],
      latch_name: availability.map((a) => a.dimensions.latch_name),
      latch_type: ["spin"],
      latch_id: availability.map((a) => a.dimensions.latch_id)
    },
    availability
  };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > DIAGNOSTIC_DEFAULTS.pendingLimitBytes / 5);
  session.context("pending").measurementEvidence!.recordInventory!(input);
  await session.flushStartupInventory();
  await session.controller.close();
  await session.metadata.close();
  const metadata = path.join(
    session.store.directory,
    session.attemptId,
    "summary",
    `metadata-${session.metadata.componentInstanceId}.jsonl`
  );
  const records = (await fs.readFile(metadata, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).record)
    .filter(Boolean);
  assert.equal(
    records.filter((r) => r.contractVersion === "measurement-native-availability.v1").length,
    1000
  );
  assert.equal(session.metadata.snapshot().droppedEvents, 0);
  const allocated = Object.values(session.nativeMount!.producers).reduce(
    (sum, p) => sum + p.pendingLimitBytes,
    0
  );
  assert.ok(allocated <= DIAGNOSTIC_DEFAULTS.pendingLimitBytes);
});

test("a full partial-summary inventory retains every scope's finding in bounded working memory", async (t) => {
  const { root, artifacts, service } = await fixture(t),
    source = run();
  const session = await service.begin(source);
  const expectations: any[] = [];
  // Independent identities exceed the former global problem-index cap, as the live run does.
  for (let table = 0; table < 34; table++)
    for (const operation of ["read", "create", "update", "delete", "write"])
      for (const statistic of ["average", "p90", "p95", "total"]) {
        const dimensions = { table: `PublicTable${table}`, operation };
        const definitionId = `db.table.${operation}`;
        expectations.push({
          ...expectation,
          expectationId: `e-${expectations.length}`,
          definitionId,
          scope: "database:table",
          dimensions,
          statistic
        });
        session.recordMetadata({
          contractVersion: "measurement-projection.v1",
          projectionStage: "STAGED",
          definitionId,
          group: "database",
          dimensions,
          statistic,
          status: "partial",
          reasonCodes: ["source_gap"],
          supportedSeconds: 7,
          estimatedSeconds: 1,
          missingSeconds: 2,
          availableBins: 1,
          omittedBins: 1,
          expectedAcquisitions: 2,
          observedAcquisitions: 1,
          minimumPercentileBins: 2,
          sourceReferences: []
        });
        await session.metadata.flush();
      }
  await session.setExpectations(expectations);
  const result = await session.seal({
    terminalState: "INCOMPLETE",
    phaseRefs: [],
    deployedRefs: {}
  });
  const findings: any[] = [];
  for (const id of result.manifest.findingPages) {
    const artifact = artifacts.find((a) => a.id === id)!;
    findings.push(
      ...JSON.parse(await fs.readFile(path.join(root, artifact.path), "utf8")).map(
        (e: any) => e.record
      )
    );
  }
  assert.equal(findings.length, expectations.length);
  assert.equal(new Set(findings.map((f) => f.expectationId)).size, expectations.length);
  assert.ok(
    findings.every((f) => f.coverage.missingSeconds === 2 && f.reasonCode === "source_gap")
  );
  assert.equal(result.manifest.findingsIncomplete, false);
  assert.equal(result.manifest.droppedEvents, 0);
});

test("one actual four-observer trace batch retains native metric-family detail under the combined pending ceiling", async (t) => {
  const { service } = await fixture(t),
    source = run("trace");
  source.id = "f024-capacity-read-timeout-5s-1-1-fa4e";
  source.experimentId = "f024-capacity-read-timeout-5s-1-1067";
  source.environmentSnapshot.scenario.observers = [
    "core",
    "openedge_db_v1",
    "openedge_pas_v1",
    "file_sampler_v1"
  ].map((kind, i) => ({ id: `observer-${i}`, kind, required: true, samplingIntervalSeconds: 5 }));
  const session = await service.begin(source),
    context = session.context("measurement");
  const { ObserverCollector } = await import("../../packages/observers/src/collector");
  let values = 0;
  const collector = new ObserverCollector(source.environmentSnapshot.scenario.observers, context, {
    create: (declaration) => ({
      id: declaration.id,
      kind: declaration.kind,
      ready: async () => true,
      sample: async (c) =>
        Array.from(
          {
            length:
              declaration.kind === "openedge_db_v1" ? 128 : declaration.kind === "core" ? 8 : 4
          },
          (_, i) => {
            values++;
            return {
              metricName: `parkbench_public_${declaration.kind}_${String(i).padStart(3, "0")}_counter_total`,
              type: "counter" as const,
              value: 0,
              timestamp: Date.now() / 1000,
              source: "public-fixture",
              labels: observerLabels(c, "observer", declaration.id)
            };
          }
        )
    })
  });
  const quality = await collector.collectPhase(context, 0, 1);
  assert.equal(values, 144);
  assert.ok(quality.every((q) => q.observed === 1));
  await session.controller.close();
  await session.metadata.close();
  assert.equal(session.controller.snapshot().droppedEvents, 0);
  const allocations = Object.values(session.nativeMount!.producers).reduce(
    (n, p) => n + p.pendingLimitBytes,
    0
  );
  assert.ok(allocations <= DIAGNOSTIC_DEFAULTS.pendingLimitBytes);
});

test("native endpoint samples are not falsely reported as missing physical database containers", async (t) => {
  const { root, service } = await fixture(t),
    source = run();
  const session = await service.begin(source);
  session.setTopology([
    { group: "database", memberId: "physical-db", service: "database", imageId: "image" },
    { group: "platform", memberId: "physical-cp", service: "control-plane", imageId: "image" }
  ]);
  const { acquireMetric } = await import("../../packages/metrics/src/measurement-summary");
  const { withQueryEvidence } = await import("../../packages/metrics/src/query-evidence");
  const { HttpPrometheusClient } = await import("../../packages/metrics/src/prometheus-client");
  const { DATABASE_SUMMARY_CATALOG } = await import("../../packages/contracts/src/summary-catalog");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: {
                __name__: "parkbench_openedge_db_database_table_operations_total",
                run_id: source.id,
                service: "database",
                operation: "read",
                database_epoch: "one"
              },
              values: [
                [1, "10"],
                [6, "20"]
              ]
            }
          ]
        }
      })
    )) as any;
  try {
    const definition = DATABASE_SUMMARY_CATALOG.find((d) => d.definitionId === "db.records.read")!;
    const values = await withQueryEvidence(session.queryContext(1000, 11000), () =>
      acquireMetric(
        new HttpPrometheusClient("http://fixture"),
        `parkbench_openedge_db_database_table_operations_total{job="parkbench-runs",run_id="${source.id}",operation="read"}`,
        {
          runId: source.id,
          window: { start: new Date(1000).toISOString(), end: new Date(11000).toISOString() },
          sourceStepSeconds: 5,
          queries: []
        } as any,
        5,
        false,
        { definition, dimensions: { operation: "read" } }
      )
    );
    assert.equal(values.length, 2);
    assert.deepEqual(
      values.map((s) => s.value),
      [10, 20]
    );
    await session.metadata.flush();
    const file = path.join(
      session.store.directory,
      session.attemptId,
      "summary",
      `metadata-${session.metadata.componentInstanceId}.jsonl`
    );
    const queries = (await fs.readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).record)
      .filter((r) => r?.contractVersion === "measurement-query-evidence.v1");
    assert.equal(queries.length, 1);
    assert.equal(queries[0].sampleCount, 2);
    assert.deepEqual(queries[0].expectedMemberIds, []);
    assert.deepEqual(queries[0].missingMemberIds, []);
    // Resource measurements still require every physical member.
    assert.deepEqual(
      session.queryContext(1000, 11000).resolveExpectedMembers!("cadvisor", "platform"),
      ["physical-cp"]
    );
  } finally {
    globalThis.fetch = originalFetch;
    await session.controller.close();
    await session.metadata.close();
  }
});

test("actual saved resource and single-path file dimensions join independent inventory scopes", async (t) => {
  const { root, artifacts, service } = await fixture(t),
    source = run(),
    session = await service.begin(source);
  const { buildMeasurementInventory } =
    await import("../../apps/control-plane/src/measurement-diagnostics/inventory");
  const inventory = buildMeasurementInventory({
    runId: source.id,
    phase: "measurement",
    startMs: 1000,
    endMs: 11000,
    sourceCadenceMs: null,
    controllerCadenceMs: 5000,
    scrapeCadenceMs: 5000,
    topology: [{ group: "database", service: "database", memberId: "physical-db" }],
    paths: [{ file: "configured-path", kind: "file", evidenceRef: "path-proof" }],
    tables: []
  });
  const expectations = [...inventory.expectations].filter(
    (e) =>
      e.statistic === "average" &&
      ((e.definitionId === "disk.read.bytes" && e.dimensions.scope === "database") ||
        e.definitionId === "disk.space.allocated" ||
        e.definitionId === "disk.space.bi_logical")
  );
  assert.equal(expectations.length, 3);
  // Source path-kind proof is independent of which publisher alias appears on a row.
  session.context("measurement").measurementEvidence!.recordInventory!({
    contractVersion: "measurement-path-inventory.v1",
    runId: source.id,
    observerId: "files",
    pathRef: "configured-path",
    kind: "file",
    capturedAtMs: 1000
  });
  for (const [definitionId, dimensions] of [
    ["disk.read.bytes", { direction: "read" }],
    ["disk.space.allocated", { scope: "file", file: "file-sampler" }],
    ["disk.space.bi_logical", { scope: "logical_bi", file: "database" }]
  ] as const) {
    session.recordMetadata({
      contractVersion: "measurement-projection.v1",
      projectionStage: "STAGED",
      definitionId,
      group: "database",
      dimensions,
      statistic: "average",
      status: "partial",
      reasonCodes: ["source_gap"],
      supportedSeconds: 7,
      estimatedSeconds: 1,
      missingSeconds: 2,
      availableBins: 1,
      omittedBins: 1,
      expectedAcquisitions: 2,
      observedAcquisitions: 1,
      minimumPercentileBins: 2,
      sourceReferences: []
    });
    await session.metadata.flush();
  }
  await session.setExpectations(expectations);
  const sealed = await session.seal({
    terminalState: "INCOMPLETE",
    phaseRefs: [],
    deployedRefs: {}
  });
  const findings: any[] = [];
  for (const id of sealed.manifest.findingPages) {
    const a = artifacts.find((a) => a.id === id)!;
    findings.push(
      ...JSON.parse(await fs.readFile(path.join(root, a.path), "utf8")).map((e: any) => e.record)
    );
  }
  assert.equal(findings.length, 3);
  assert.ok(findings.every((f) => f.coverage.missingSeconds === 2));
});

test("file scope normalization preserves independent paths and a healthy sibling", async (t) => {
  const { root, artifacts, service } = await fixture(t),
    source = run(),
    session = await service.begin(source);
  for (const file of ["path-a", "path-b"])
    session.context("measurement").measurementEvidence!.recordInventory!({
      contractVersion: "measurement-path-inventory.v1",
      runId: source.id,
      observerId: file,
      pathRef: file,
      kind: "file",
      capturedAtMs: 1000
    });
  for (const file of ["path-a", "path-b"]) {
    session.recordMetadata({
      contractVersion: "measurement-projection.v1",
      projectionStage: "STAGED",
      definitionId: "disk.space.allocated",
      group: "database",
      dimensions: { scope: "file", file },
      statistic: "average",
      status: file === "path-a" ? "partial" : "available",
      reasonCodes: file === "path-a" ? ["source_gap"] : [],
      supportedSeconds: file === "path-a" ? 7 : 10,
      estimatedSeconds: 0,
      missingSeconds: file === "path-a" ? 3 : 0,
      availableBins: 2,
      omittedBins: file === "path-a" ? 1 : 0,
      expectedAcquisitions: 2,
      observedAcquisitions: 2,
      minimumPercentileBins: 2,
      sourceReferences: []
    });
    await session.metadata.flush();
  }
  await session.setExpectations(
    ["path-a", "path-b"].map((file) => ({
      ...expectation,
      expectationId: file,
      definitionId: "disk.space.allocated",
      scope: "database:file",
      dimensions: { scope: "file", file },
      statistic: "average"
    }))
  );
  const sealed = await session.seal({
      terminalState: "INCOMPLETE",
      phaseRefs: [],
      deployedRefs: {}
    }),
    findings: any[] = [];
  for (const id of sealed.manifest.findingPages) {
    const a = artifacts.find((a) => a.id === id)!;
    findings.push(
      ...JSON.parse(await fs.readFile(path.join(root, a.path), "utf8")).map((e: any) => e.record)
    );
  }
  assert.deepEqual(
    findings.map((f) => [f.expectationId, f.coverage.missingSeconds]),
    [["path-a", 3]]
  );
});

test("retained startup availability flows into exact native and summary limitation findings", async (t) => {
  const { root, artifacts, service } = await fixture(t),
    source = run();
  source.id = "owned-run";
  const { nativeMeasurementInventory } =
    await import("../../packages/observers/src/measurement-inventory");
  const { parseOpenEdgeDbObserverOutput } =
    await import("../../packages/observers/src/openedge-db/adapter");
  const { namedLatchSnapshot } = await import("../helpers/openedge-db-v4");
  const snapshot = namedLatchSnapshot();
  snapshot.collectedAt = new Date().toISOString();
  snapshot.snapshot._Trans = [];
  const native = nativeMeasurementInventory(
    parseOpenEdgeDbObserverOutput(JSON.stringify(snapshot)),
    source.id
  );
  const session = await service.begin(source);
  session.setTopology([
    { group: "database", service: "database", memberId: "physical-db", imageId: "fixture" }
  ]);
  session.context("pending").measurementEvidence!.recordInventory!(native);
  const startMs = native.capturedAtMs + 1000;
  await session.prepareInventory(
    { startMs, endMs: startMs + 10000 },
    { controllerCadenceMs: 5000, scrapeCadenceMs: 5000 }
  );
  const sealed = await session.seal({
    terminalState: "SUCCEEDED",
    phaseRefs: [],
    deployedRefs: {}
  });
  const expectations: any[] = [],
    findings: any[] = [];
  for (const artifact of artifacts.filter((a) =>
    ["inventory", "findings"].includes(a.sourceMetadata?.role)
  )) {
    for (const e of JSON.parse(await fs.readFile(path.join(root, artifact.path), "utf8"))) {
      if (e.record?.contractVersion === "measurement-expectation.v1") expectations.push(e.record);
      if (e.record?.contractVersion === "measurement-finding.v1") findings.push(e.record);
    }
  }
  const alternate = expectations.filter(
    (e) => e.definitionId === "db.buffer.logical.read" && e.dimensions.pool === "alternate"
  );
  assert.ok(alternate.length);
  for (const expected of alternate) {
    assert.equal(expected.applicability, "INAPPLICABLE");
    const finding = findings.find((f) => f.expectationId === expected.expectationId);
    assert.equal(finding.classification, "LEGITIMATE_LIMITATION");
    assert.equal(finding.reasonCode, "alternate_pool_disabled");
    assert.ok(finding.evidenceRefs.includes(native.evidenceId));
  }
  assert.equal(sealed.manifest.droppedEvents, 0);
});

test("explicit quiescent recovery charges uncertain reservations in full without rewriting sealed evidence or admitting unreconciled detail", async (t) => {
  const { root, artifacts, service } = await fixture(t),
    source = run("trace");
  source.environmentSnapshot.scenario.observers = [
    { id: "openedge-db", kind: "openedge_db_v1", required: true }
  ];
  const session = await service.begin(source);
  const reservation = {
    reservationId: "33333333-3333-4333-8333-333333333333",
    attemptId: session.attemptId,
    producerId: "db-observer-crashed",
    summaryBytes: 8192,
    traceBytes: 16384
  };
  await session.store.reserve(reservation);
  await session.store.markUnconfirmed();
  const sealed = await session.seal({
    terminalState: "SUCCEEDED",
    phaseRefs: [],
    deployedRefs: {}
  });
  assert.equal(sealed.manifest.recordingState, "UNAVAILABLE");
  const original = await fs.readFile(path.join(root, sealed.artifact.path)),
    before = await session.store.read();
  const remaining = before.reservations.filter((r) => r.reservationId !== "retention-control");
  assert.ok(remaining.some((r) => r.reservationId === reservation.reservationId));
  await assert.rejects(
    (service as any).reconcileBudget(source, async () => {
      throw Error("not_quiescent");
    }),
    /not_quiescent/
  );
  assert.deepEqual(await session.store.read(), before);
  let stopped = 0;
  const result = await (service as any).reconcileBudget(source, async () => {
    stopped++;
  });
  assert.equal(stopped, 1);
  assert.equal(result.recordingState, "UNAVAILABLE");
  const after = await session.store.read();
  assert.equal(after.accountingState, "CONFIRMED");
  assert.equal(
    after.committedTraceBytes,
    before.committedTraceBytes + remaining.reduce((n, r) => n + r.traceBytes, 0)
  );
  assert.ok(
    after.committedSummaryBytes >=
      before.committedSummaryBytes + remaining.reduce((n, r) => n + r.summaryBytes, 0)
  );
  assert.deepEqual(
    after.reservations.map((r) => r.reservationId),
    ["retention-control"]
  );
  assert.deepEqual(await fs.readFile(path.join(root, sealed.artifact.path)), original);
  assert.equal(source.measurementValidity, "VALID");
  assert.equal(
    artifacts.filter((a) => a.sourceMetadata?.role === "budget-reconciliation").length,
    1
  );
  await (service as any).reconcileBudget(source, async () => {
    stopped++;
  });
  assert.deepEqual(await session.store.read(), after);
  assert.equal(
    artifacts.filter((a) => a.sourceMetadata?.role === "budget-reconciliation").length,
    1
  );
});

test("source expiry removes queryable readings independently of sealed diagnostics and saved results", async (t) => {
  const { root, artifacts, service } = await fixture(t),
    source = run("trace");
  const session = await service.begin(source);
  await session.setExpectations([expectation]);
  session.context("measurement").measurementEvidence.record(event);
  const sealed = await session.seal({
    terminalState: "SUCCEEDED",
    phaseRefs: ["phase-1"],
    deployedRefs: {}
  });
  const manifestPath = path.join(root, sealed.artifact.path),
    originalManifest = await fs.readFile(manifestPath),
    originalBudget = await session.store.read();
  let expired = false,
    reads = 0;
  const server = createServer((_request, response) => {
    reads++;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: expired
            ? []
            : [
                {
                  metric: { __name__: "public_gauge", run_id: "run-1" },
                  values: [
                    [1, "7"],
                    [6, "7"]
                  ]
                }
              ]
        }
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const prom = new HttpPrometheusClient(`http://127.0.0.1:${address.port}`);
  const selector = 'public_gauge{run_id="run-1"}',
    window = { start: 1, end: 11 };
  const summarize = (samples: { timestamp: number; value: number }[]) =>
    measurementStatistics([{ cadenceSeconds: 5, observations: samples }], window, {
      type: "gauge",
      unit: "count"
    });
  const stored = await prom.queryRawRange(selector, 1, 11, 5),
    saved = summarize(stored),
    savedBytes = JSON.stringify(saved);
  assert.equal(stored.length, 2);
  assert.equal(saved.statistics.average.value, 7);
  assert.equal(saved.coverage.missingSeconds, 0);
  expired = true;
  const nowMissing = await prom.queryRawRange(selector, 1, 11, 5),
    live = summarize(nowMissing);
  assert.equal(nowMissing.length, 0);
  assert.equal(live.statistics.average.value, null);
  assert.equal(live.coverage.observedAcquisitions, 0);
  assert.equal(live.coverage.missingSeconds, 10);
  assert.equal(JSON.stringify(saved), savedBytes);
  const reopened = new MeasurementDiagnosticsService({
    artifactRoot: root,
    registerArtifact: () => {
      throw Error("historical read attempted a write");
    },
    listArtifacts: () => artifacts
  });
  assert.equal((await reopened.read(source)).recordingState, "SEALED");
  assert.deepEqual(await fs.readFile(manifestPath), originalManifest);
  assert.deepEqual(await session.store.read(), originalBudget);
  assert.equal(source.measurementValidity, "VALID");
  assert.equal(artifacts.filter((a) => a.sourceMetadata?.role === "retention-event").length, 0);
  assert.equal(reads, 2);
});
