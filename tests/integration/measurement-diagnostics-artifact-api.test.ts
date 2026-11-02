import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import { MeasurementDiagnosticsService } from "../../apps/control-plane/src/measurement-diagnostics/evidence";
import { DIAGNOSTIC_DEFAULTS } from "../../packages/contracts/src/measurement-diagnostics";
import scenario from "../../examples/scenarios/crud-rest.json";
test("existing history and artifact APIs discover immutable attempts and join expiry; downloads remain run-scoped", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-evidence-api-"));
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://fixture",
      prometheusRetention: "7d",
      measurementDiagnostics: DIAGNOSTIC_DEFAULTS,
      openedge: {}
    } as any,
    { testMode: true }
  );
  const app = buildServer(platform);
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await platform.startupRecovery;
  platform.scenarios.register(scenario as any);
  platform.controlUi.syncExistingScenarios();
  const preview = platform.controlUi.preview({
    runName: "evidence-api",
    scenario: { id: scenario.id, version: scenario.version },
    dimensions: [],
    repetitions: 1,
    measurementDiagnostics: { contractVersion: "measurement-diagnostics-config.v1", mode: "trace" }
  } as any);
  const accepted = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
  const run = platform.repositories.getRun(accepted.runs[0].id)!;
  const service = new MeasurementDiagnosticsService({
    artifactRoot: root,
    registerArtifact: (a) => platform.repositories.saveArtifact(a),
    listArtifacts: (id) => platform.repositories.listArtifacts(id)
  });
  const session = await service.begin(run);
  const sealed = await session.seal({ terminalState: "FAILED", phaseRefs: [], deployedRefs: {} });
  platform.repositories.saveRun(run);
  const listing = await app.inject({ url: `/api/v1/runs/${run.id}/artifacts` });
  assert.equal(listing.statusCode, 200);
  assert.ok(listing.json().artifacts.some((a: any) => a.id === sealed.artifact.id));
  const trace = listing.json().artifacts.find((a: any) => a.sourceMetadata?.role === "trace");
  assert.ok(trace);
  assert.equal(trace.sourceMetadata.retention.availability, "AVAILABLE");
  const bytes = await fs.readFile(path.join(root, sealed.artifact.path));
  await platform.measurementRetention.expire(
    platform.repositories.listArtifacts(run.id).find((a) => a.id === trace.id)!,
    "detail_ttl_elapsed"
  );
  const history = await app.inject({ url: `/api/v1/history/runs/${run.id}` });
  assert.equal(history.statusCode, 200);
  assert.equal(
    history.json().artifacts.find((a: any) => a.id === trace.id).sourceMetadata.retention
      .availability,
    "EXPIRED"
  );
  assert.deepEqual(await fs.readFile(path.join(root, sealed.artifact.path)), bytes);
  assert.equal(
    (await app.inject({ url: `/api/v1/runs/${run.id}/artifacts/${trace.id}` })).statusCode,
    404
  );
  assert.equal(
    (await app.inject({ url: `/api/v1/runs/other-run/artifacts/${sealed.artifact.id}` }))
      .statusCode,
    404
  );
  const download = await app.inject({
    url: `/api/v1/runs/${run.id}/artifacts/${sealed.artifact.id}`
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.body, bytes.toString());
  // Explicit recovery is a mutation with terminal/ownership guards; ordinary GETs
  // above still leave every original manifest untouched.
  run.state = "FAILED";
  run.cleanupStatus = "COMPLETE";
  const recovery = await service.begin(run, { audit: true });
  run.environmentSnapshot!.measurementDiagnosticsMount = recovery.nativeMount;
  await recovery.store.markUnconfirmed();
  const unavailable = await recovery.seal({
    terminalState: "FAILED",
    phaseRefs: [],
    deployedRefs: {}
  });
  platform.repositories.saveRun(run);
  const originalUnavailable = await fs.readFile(path.join(root, unavailable.artifact.path));
  let quiescences = 0;
  (platform.orchestrator as any).quiesceMeasurementProducers = async (bundle: any) => {
    quiescences++;
    assert.equal(bundle.projectName, run.composeProject);
    assert.equal(bundle.resources[0].labels["parkbench.run_id"], run.id);
  };
  const url = `/api/v1/history/runs/${run.id}/diagnostics/reconcile-budget`;
  assert.equal(
    (await app.inject({ method: "POST", url, payload: { unknown: true } })).statusCode,
    400
  );
  const reconciled = await app.inject({ method: "POST", url });
  assert.equal(reconciled.statusCode, 200, reconciled.body);
  assert.equal(reconciled.json().accountingState, "CONFIRMED");
  assert.equal(reconciled.json().recordingState, "UNAVAILABLE");
  const committed = await recovery.store.read();
  assert.equal((await app.inject({ method: "POST", url })).statusCode, 200);
  assert.deepEqual(await recovery.store.read(), committed);
  assert.equal(quiescences, 1);
  assert.deepEqual(
    await fs.readFile(path.join(root, unavailable.artifact.path)),
    originalUnavailable
  );
  const receipt = platform.repositories
    .listArtifacts(run.id)
    .find((a) => a.sourceMetadata?.role === "budget-reconciliation")!;
  const receiptDownload = await app.inject({
    url: `/api/v1/runs/${run.id}/artifacts/${receipt.id}`
  });
  assert.equal(receiptDownload.statusCode, 200);
  assert.equal(receiptDownload.json().producerCompleteness, "UNCONFIRMED");
});
