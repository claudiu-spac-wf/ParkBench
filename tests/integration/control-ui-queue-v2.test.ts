import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import { ScenarioFileSource } from "../../apps/control-plane/src/catalog/scenario-source";

test("Queue retains queued, active, and blocked runs while History links a terminal result", async () => {
  const scenarios = path.resolve("tests/fixtures/simplify-run-workflow/scenarios");
  const platform = createPlatform({ host: "127.0.0.1", port: 0, dbPath: ":memory:",
    artifactRoot: ".parkbench/test-queue-v2", prometheusUrl: "http://127.0.0.1:9090",
    prometheusRetention: "7d", discoveryRoots: { scenarios }, openedge: {} } as any,
    { testMode: true });
  const app = buildServer(platform);
  try {
    await app.ready();
    const sourceId = new ScenarioFileSource(scenarios).list()
      .find((item) => item.relativePath === "scenario-v2.json")!.id;
    const preview = platform.controlUi.preview({ runName: "Queue Sweep", scenarioSourceId: sourceId,
      dimensions: [{ name: "-B", values: [500, 1000, 1500, 2000] }], repetitions: 1 } as any);
    const submitted = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
    const [finished, running, waiting, blocked] = submitted.runs.map((run) => run.id);
    platform.database.db.prepare("UPDATE runs SET state='SUCCEEDED',measurement_validity='VALID' WHERE id=?").run(finished);
    platform.database.db.prepare("UPDATE runs SET state='MEASURING' WHERE id=?").run(running);
    const blockedMetadata = platform.controlRepository.getRunMetadata(blocked)!;
    platform.controlRepository.saveRunMetadata({ runId: blocked, ...blockedMetadata,
      queueState: "BLOCKED", blockedReason: "archive_missing", updatedAt: new Date().toISOString() });
    const queue = (await app.inject({ method: "GET", url: "/api/v1/queue" })).json();
    assert.deepEqual(new Set(queue.items.map((item: any) => item.id)), new Set([running, waiting, blocked]));
    assert.equal(queue.items.find((item: any) => item.id === blocked).blockedReason, "archive_missing");
    const overview = (await app.inject({ method: "GET", url: "/api/v1/overview" })).json();
    assert.equal(overview.queue.queued, 1);
    assert.equal(overview.queue.running, 1);
    assert.equal(overview.queue.blocked, 1);
    const history = (await app.inject({ method: "GET", url: "/api/v1/history/runs" })).json();
    const item = history.items.find((entry: any) => entry.id === finished);
    assert.match(item.dashboardContextId, /^queue-sweep-[0-9a-f]{4}$/);
    const detail = (await app.inject({ method: "GET", url: `/api/v1/history/runs/${finished}` })).json();
    assert.equal(detail.dashboardContexts[0].id, item.dashboardContextId);
    assert.equal(platform.controlRepository.listDashboards().filter((entry) => entry.runIds[0] === finished).length, 1);
  } finally { await app.close(); }
});

test("Start eligible work uses resolved saved inputs and retries a blocked experiment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-queue-start-"));
  const scenarios = path.resolve("tests/fixtures/simplify-run-workflow/scenarios");
  const inner = path.join(root, "inner");
  const outer = path.join(root, "outer");
  fs.mkdirSync(path.join(inner, "openedge/Workloads/Sports2020"), { recursive: true });
  fs.mkdirSync(path.join(outer, "ablapps"), { recursive: true });
  fs.writeFileSync(path.join(inner, "openedge/Workloads/Sports2020/crud_cycle.r"), "compiled");
  execFileSync("zip", ["-q", path.join(outer, "ablapps/parkbench.zip"), "openedge/Workloads/Sports2020/crud_cycle.r"], { cwd: inner });
  execFileSync("zip", ["-q", path.join(root, "application.zip"), "ablapps/parkbench.zip"], { cwd: outer });
  const seed = path.join(root, "seed.tar.gz");
  fs.writeFileSync(seed, "seed fixture");
  const platform = createPlatform({ host: "127.0.0.1", port: 0, dbPath: ":memory:",
    artifactRoot: path.join(root, "artifacts"), prometheusUrl: "http://127.0.0.1:9090",
    prometheusRetention: "7d", discoveryRoots: { scenarios }, openedge: {} } as any,
    { testMode: true });
  try {
    await platform.startupRecovery;
    const sourceId = new ScenarioFileSource(scenarios).list()
      .find((item) => item.relativePath === "scenario-v2.json")!.id;
    const preview = platform.controlUi.preview({ runName: "Start Sweep", scenarioSourceId: sourceId,
      dimensions: [{ name: "-B", values: [500] }], repetitions: 1,
      inputs: { seed: "input:seed", applicationArchive: "input:archive" } } as any);
    const submitted = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
    const experiment = platform.repositories.getExperiment(submitted.id)!;
    platform.database.db.prepare("UPDATE experiments SET inputs=? WHERE id=?")
      .run(JSON.stringify({ ...experiment.inputs, seed, applicationArchive: path.join(root, "application.zip") }), submitted.id);
    platform.controlRepository.updateControlExperiment(submitted.id, { status: "BLOCKED" });
    const run = platform.controlRepository.getRunMetadata(submitted.runs[0].id)!;
    platform.controlRepository.saveRunMetadata({ runId: run.id, ...run, queueState: "BLOCKED",
      blockedReason: "archive_unverifiable:input:archive", updatedAt: new Date().toISOString() });
    const runtime = (platform.controlUi as any).runtime;
    runtime.testMode = false;
    runtime.databaseCapabilities={version:"12.8.11",features:[]};
    runtime.inputRoot = root;
    runtime.coordinatorHealth = async () => true;
    runtime.prometheusHealth = async () => true;
    runtime.inspectImage = async () => true;
    runtime.diskIoSources = async () => ({ cadvisor: true, nodeExporterBlockDevice: true });
    const started = await platform.controlUi.startQueue();
    assert.equal(started.started, submitted.id);
    assert.equal(platform.controlUi.getExperiment(submitted.id)?.status, "RUNNING");
    assert.equal(platform.controlUi.getExperiment(submitted.id)?.runs[0].blockedReason, undefined);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (["SUCCEEDED", "PARTIAL", "FAILED"].includes(platform.repositories.getExperiment(submitted.id)?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(["SUCCEEDED", "PARTIAL", "FAILED"].includes(platform.repositories.getExperiment(submitted.id)?.status ?? ""));
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Start eligible work starts queued work before retrying an older blocked experiment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-queue-order-"));
  const scenarios = path.resolve("tests/fixtures/simplify-run-workflow/scenarios");
  const platform = createPlatform({ host: "127.0.0.1", port: 0, dbPath: ":memory:",
    artifactRoot: path.join(root, "artifacts"), prometheusUrl: "http://127.0.0.1:9090",
    prometheusRetention: "7d", discoveryRoots: { scenarios }, openedge: {} } as any,
    { testMode: true });
  try {
    await platform.startupRecovery;
    const sourceId = new ScenarioFileSource(scenarios).list()
      .find((item) => item.relativePath === "scenario-v2.json")!.id;
    const submit = (runName: string) => {
      const preview = platform.controlUi.preview({ runName, scenarioSourceId: sourceId,
        dimensions: [{ name: "-B", values: [500] }], repetitions: 1 } as any);
      return platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
    };
    const blocked = submit("Blocked First");
    const queued = submit("Queued Second");
    platform.controlRepository.updateControlExperiment(blocked.id, { status: "BLOCKED" });
    const metadata = platform.controlRepository.getRunMetadata(blocked.runs[0].id)!;
    platform.controlRepository.saveRunMetadata({ runId: metadata.id, ...metadata,
      queueState: "BLOCKED", blockedReason: "missing_input", updatedAt: new Date().toISOString() });
    assert.equal((await platform.controlUi.startQueue()).started, queued.id);
    assert.equal(platform.controlUi.getExperiment(blocked.id)?.status, "BLOCKED");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (["SUCCEEDED", "PARTIAL", "FAILED"].includes(platform.repositories.getExperiment(queued.id)?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(["SUCCEEDED", "PARTIAL", "FAILED"].includes(platform.repositories.getExperiment(queued.id)?.status ?? ""));
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
