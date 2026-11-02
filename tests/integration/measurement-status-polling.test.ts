import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import { ScenarioFileSource } from "../../apps/control-plane/src/catalog/scenario-source";
import { HttpMetricsObserver } from "../../packages/observers/src/http-observer";

async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-status-poll-"));
  const scenarios = path.resolve("tests/fixtures/simplify-run-workflow/scenarios");
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://unused",
      prometheusRetention: "7d",
      discoveryRoots: {
        scenarios,
        workloads: path.resolve("openedge/Workloads"),
        observers: path.resolve("examples/observers"),
        seeds: root,
        archives: root
      },
      openedge: {}
    },
    { testMode: true }
  );
  const app = buildServer(platform);
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.ready();
  const sourceId = new ScenarioFileSource(scenarios)
    .list()
    .find((item) => item.relativePath === "scenario-v2.json")!.id;
  const preview = platform.controlUi.preview({
    runName: "Status polling",
    scenarioSourceId: sourceId,
    dimensions: [{ name: "-B", values: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000] }],
    repetitions: 1
  } as any);
  const submitted = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
  for (const run of submitted.runs)
    platform.database.db
      .prepare("UPDATE runs SET state='SUCCEEDED',measurement_validity='VALID' WHERE id=?")
      .run(run.id);
  // Finish the initial projection, so subsequent GETs observe unchanged history.
  await app.inject({ method: "GET", url: "/api/v1/queue" });
  return { platform, app, submitted };
}

test("unchanged queue polling cannot stall an unrelated fast measurement behind historical database writes", async (t) => {
  const { platform, app } = await fixture(t);
  let writes = 0;
  const delay = new Int32Array(new SharedArrayBuffer(4));
  // A deterministic persistent-storage stall is injected only on actual writes.
  for (const key of ["saveRunMetadata", "updateControlExperiment"] as const) {
    const original = platform.controlRepository[key].bind(platform.controlRepository);
    (platform.controlRepository as any)[key] = (...args: any[]) => {
      writes++;
      Atomics.wait(delay, 0, 0, 12);
      return (original as any)(...args);
    };
  }
  const worker = new Worker(
    `
    const {parentPort}=require('node:worker_threads'); const http=require('node:http');
    http.createServer((req,res)=>{parentPort.postMessage({requested:true});setTimeout(()=>{res.setHeader('Content-Type','text/plain');res.end('measured 17\\n');parentPort.postMessage({finishedAt:Date.now()});},20);}).listen(0,'127.0.0.1',function(){parentPort.postMessage({url:'http://127.0.0.1:'+this.address().port});});
  `,
    { eval: true }
  );
  t.after(() => worker.terminate());
  const [ready] = await once(worker, "message");
  let requests = 0;
  worker.on("message", (message) => {
    if (message.requested) requests++;
  });
  const requested = once(worker, "message"),
    events: any[] = [];
  const observer = new HttpMetricsObserver("native", "openedge_db_v1", ready.url, "/metrics", 100);
  const pending = observer.sample({
    runId: "run",
    experimentId: "exp",
    variantId: "v",
    repetition: 1,
    phase: "measurement",
    measurementEvidence: {
      diagnosticAttemptId: "a",
      record: (event: any) => {
        events.push(event);
        return `e-${events.length}`;
      }
    }
  });
  // Attach rejection handling before deliberately blocking the event loop.
  const result = pending.then(
    (samples) => ({ samples, error: null }),
    (error) => ({ samples: [], error })
  );
  await requested;
  const queue = (await app.inject({ method: "GET", url: "/api/v1/queue" })).json();
  assert.deepEqual(queue.items, []);
  const acquired = await result;
  assert.equal(acquired.error, null);
  assert.equal(acquired.samples[0].value, 17);
  assert.equal(
    requests,
    1,
    "a healthy source must not be retried because a status read rewrites old rows"
  );
  assert.equal(writes, 0, "unchanged status/history reads have no persistence work");
  assert.ok(!events.some((event) => event.outcome === "TIMED_OUT"));
});

test("status projections persist real changes once and retain blocked-work and setup evidence", async (t) => {
  const { platform, app, submitted } = await fixture(t);
  let writes = 0;
  const save = platform.controlRepository.saveRunMetadata.bind(platform.controlRepository);
  platform.controlRepository.saveRunMetadata = (record) => {
    writes++;
    save(record);
  };
  const id = submitted.runs[0].id;
  platform.database.db.prepare("UPDATE runs SET state='MEASURING' WHERE id=?").run(id);
  const first = (await app.inject({ method: "GET", url: "/api/v1/queue" })).json();
  assert.equal(first.items.find((run: any) => run.id === id).state, "MEASURING");
  assert.equal(writes, 1);
  const updatedAt = platform.controlRepository.getRunMetadata(id)!.updatedAt;
  await app.inject({ method: "GET", url: "/api/v1/queue" });
  assert.equal(writes, 1);
  assert.equal(platform.controlRepository.getRunMetadata(id)!.updatedAt, updatedAt);
  const live = platform.repositories.getRun(id)!;
  live.environmentSnapshot = {
    ...live.environmentSnapshot,
    databaseSetupEvidence: { state: "RUNNING", phase: "utility" }
  };
  platform.repositories.saveRun(live);
  const setup = (await app.inject({ method: "GET", url: "/api/v1/queue" }))
    .json()
    .items.find((run: any) => run.id === id);
  assert.equal(setup.databaseSetup.state, "RUNNING");
  assert.equal(setup.databaseSetup.phase, "utility");
  assert.equal(writes, 1, "fresh projected detail does not require an extra metadata write");
  let experimentWrites = 0;
  const updateExperiment = platform.controlRepository.updateControlExperiment.bind(
    platform.controlRepository
  );
  platform.controlRepository.updateControlExperiment = (...args) => {
    experimentWrites++;
    updateExperiment(...args);
  };
  platform.repositories.updateExperimentStatus(submitted.id, "RUNNING");
  const active = (await app.inject({ method: "GET", url: "/api/v1/queue" })).json();
  assert.equal(active.activeExperiment, submitted.id);
  assert.equal(experimentWrites, 1);
  await app.inject({ method: "GET", url: "/api/v1/queue" });
  assert.equal(experimentWrites, 1);
  const blockedId = submitted.runs[1].id;
  platform.database.db.prepare("UPDATE runs SET state='QUEUED' WHERE id=?").run(blockedId);
  const metadata = platform.controlRepository.getRunMetadata(blockedId)!;
  save({
    runId: blockedId,
    ...metadata,
    queueState: "BLOCKED",
    blockedReason: "temporary_host_capacity",
    retryCount: 3,
    updatedAt: metadata.updatedAt
  });
  const blocked = (await app.inject({ method: "GET", url: "/api/v1/queue" }))
    .json()
    .items.find((run: any) => run.id === blockedId);
  assert.equal(blocked.queueState, "BLOCKED");
  assert.equal(blocked.blockedReason, "temporary_host_capacity");
  assert.equal(blocked.retryCount, 3);
});

test("queue polling cannot time out a healthy source while hydrating unrelated historical snapshots", async (t) => {
  const { platform, app, submitted } = await fixture(t);
  let historicalReads = 0;
  const delay = new Int32Array(new SharedArrayBuffer(4)),
    historicalIds = new Set(submitted.runs.map((run) => run.id));
  const read = platform.repositories.getRun.bind(platform.repositories);
  platform.repositories.getRun = (id) => {
    if (historicalIds.has(id)) {
      historicalReads++;
      Atomics.wait(delay, 0, 0, 12);
    }
    return read(id);
  };
  const worker = new Worker(
    `
    const {parentPort}=require('node:worker_threads'); const http=require('node:http');
    http.createServer((req,res)=>{parentPort.postMessage({requested:true});setTimeout(()=>{res.setHeader('Content-Type','text/plain');res.end('measured 17\\n');parentPort.postMessage({finishedAt:Date.now()});},20);}).listen(0,'127.0.0.1',function(){parentPort.postMessage({url:'http://127.0.0.1:'+this.address().port});});
  `,
    { eval: true }
  );
  t.after(() => worker.terminate());
  const [ready] = await once(worker, "message");
  let requests = 0;
  worker.on("message", (message) => {
    if (message.requested) requests++;
  });
  const requested = once(worker, "message"),
    events: any[] = [];
  const observer = new HttpMetricsObserver("native", "openedge_db_v1", ready.url, "/metrics", 100);
  const pending = observer.sample({
    runId: "run",
    experimentId: "exp",
    variantId: "v",
    repetition: 1,
    phase: "measurement",
    measurementEvidence: {
      diagnosticAttemptId: "a",
      record: (event: any) => {
        events.push(event);
        return `e-${events.length}`;
      }
    }
  });
  // Attach rejection handling before deliberately blocking the event loop.
  const result = pending.then(
    (samples) => ({ samples, error: null }),
    (error) => ({ samples: [], error })
  );
  await requested;
  const queue = (await app.inject({ method: "GET", url: "/api/v1/queue" })).json();
  assert.deepEqual(queue.items, []);
  const acquired = await result;
  assert.equal(acquired.error, null);
  assert.equal(acquired.samples[0].value, 17);
  assert.equal(
    requests,
    1,
    "a healthy source must not be retried because a queue read hydrates unrelated history"
  );
  assert.equal(historicalReads, 0, "terminal history snapshots are outside the queue response");
  assert.ok(!events.some((event) => event.outcome === "TIMED_OUT"));
});

test("queue status remains available when an unrelated historical snapshot cannot be decoded", async (t) => {
  const { platform, app, submitted } = await fixture(t),
    active = submitted.runs[0].id,
    historical = submitted.runs[1].id;
  platform.database.db.prepare("UPDATE runs SET state='MEASURING' WHERE id=?").run(active);
  platform.database.db
    .prepare("UPDATE runs SET environment_snapshot='invalid historical JSON' WHERE id=?")
    .run(historical);
  const response = await app.inject({ method: "GET", url: "/api/v1/queue" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().items.map((r: any) => r.id),
    [active]
  );
  assert.equal(response.json().items[0].state, "MEASURING");
  assert.throws(() => platform.repositories.getRun(historical), /JSON|Unexpected/);
});
