import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { namedLatchSnapshot } from "../helpers/openedge-db-v4";
import { readOpenEdgeDbObserverPayload } from "../../packages/observers/src/openedge-db/adapter";

async function command(t: any, source: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-native-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const procedure = path.join(root, "public.cjs");
  await fs.writeFile(procedure, source);
  const events: any[] = [];
  const options = {
    executable: process.execPath,
    procedure,
    allowNonProcedure: true,
    timeoutMs: 600,
    onStage: (e: any) => events.push(e)
  };
  return { options, events, procedure };
}

test("native failure metadata distinguishes the actual child deadline without retaining stderr or arguments", async (t) => {
  const { options, events, procedure } = await command(
    t,
    "process.stderr.write('fixture-private-stderr');process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),1800);"
  );
  await assert.rejects(
    readOpenEdgeDbObserverPayload(options),
    (e: any) => e.killed && e.signal === "SIGKILL"
  );
  const failure = events.find((e) => e.stage === "PROCESS" && e.outcome === "FAILED");
  assert.equal(failure.failure?.code, "native_process_deadline");
  assert.equal(failure.failure?.signal, "SIGKILL");
  assert.equal(failure.failure?.outputState, "NONE");
  assert.equal(failure.failure?.outputBytes, 0);
  assert.ok(!JSON.stringify(events).includes("fixture-private-stderr"));
  assert.ok(!JSON.stringify(events).includes(procedure));
});

test("a timed-out child with a complete validated frame stays rejected and reports only its completion metadata", async (t) => {
  const payload = namedLatchSnapshot(),
    text = JSON.stringify(payload);
  const { options, events } = await command(
    t,
    `process.stdout.write(${JSON.stringify(text)});setTimeout(()=>process.exit(0),1800);`
  );
  await assert.rejects(readOpenEdgeDbObserverPayload(options));
  const failure = events.find((e) => e.stage === "PROCESS" && e.outcome === "FAILED");
  assert.equal(failure.failure?.code, "native_process_deadline");
  assert.equal(failure.failure?.outputState, "VALID");
  assert.equal(failure.failure?.outputBytes, Buffer.byteLength(text));
  assert.equal(failure.failure?.sourceCapturedAtMs, Date.parse(payload.collectedAt));
  assert.ok(!JSON.stringify(events).includes('"metrics"'));
  assert.ok(!events.some((e) => e.stage === "PROCESS" && e.outcome === "SUCCEEDED"));
});

test("native process exit is distinct from a deadline and private error output stays excluded", async (t) => {
  const { options, events } = await command(
    t,
    "process.stderr.write('fixture-private-stderr');process.exit(7);"
  );
  await assert.rejects(readOpenEdgeDbObserverPayload(options), (e: any) => e.code === 7);
  const failure = events.find((e) => e.stage === "PROCESS" && e.outcome === "FAILED");
  assert.equal(failure.failure?.code, "native_process_exit");
  assert.equal(failure.failure?.exitCode, 7);
  assert.equal(failure.failure?.signal, null);
  assert.ok(!JSON.stringify(events).includes("fixture-private-stderr"));
});

test("bounded native capture status remains useful without a diagnostics writer and never retains private fields", async () => {
  const { NativeCaptureStatus } =
    await import("../../packages/observers/src/openedge-db/native-capture-status");
  const status = new NativeCaptureStatus("owned-run");
  for (let i = 0; i < 70; i++)
    status.observe({ sourceKey: "native-instance", collectionGeneration: i + 1 }, {
      stage: "PROCESS",
      outcome: "FAILED",
      startedAtMs: 1000 + i,
      finishedAtMs: 1600 + i,
      durationMs: 600,
      failure: {
        code: "native_process_deadline",
        exitCode: null,
        signal: "SIGKILL",
        outputState: "NONE",
        outputBytes: 0,
        sourceCapturedAtMs: null,
        stderr: "fixture-private-stderr",
        argv: ["fixture-private-argument"]
      }
    } as any);
  const result = status.snapshot();
  assert.equal(result.contractVersion, "measurement-native-capture-status.v1");
  assert.equal(result.runId, "owned-run");
  assert.equal(result.failureCount, 70);
  assert.equal(result.retainedFailureCount, 64);
  assert.equal(result.droppedFailures, 6);
  assert.equal(result.historyComplete, false);
  assert.equal(result.failures[0].collectionGeneration, 7);
  assert.ok(!JSON.stringify(result).includes("fixture-private"));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 65536);
  result.failures.length = 0;
  assert.equal(status.snapshot().retainedFailureCount, 64);
});

test("native status endpoint does not acquire data and exposes safe failure metadata with callbacks disabled", async (t) => {
  const { spawn } = await import("node:child_process");
  const net = await import("node:net");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-native-status-api-"));
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const executable = path.join(root, "adapter.cjs"),
    counter = path.join(root, "calls");
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(counter)},'1');process.stderr.write('fixture-private-stderr');process.exit(7);\n`,
    { mode: 0o755 }
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PARKBENCH_")) delete env[key];
  const child = spawn(process.execPath, [path.resolve("dist/apps/observer/src/index.js")], {
    env: {
      ...env,
      PARKBENCH_ENV_FILE: path.join(root, "absent.env"),
      PARKBENCH_OBSERVER_KIND: "openedge_db_v1",
      PARKBENCH_METRICS_PORT: String(port),
      PARKBENCH_RUN_ID: "status-run",
      PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE: executable,
      PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE: "parkbench-db-observer-v2.r"
    },
    stdio: "pipe"
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = (route: string) =>
    fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(2000) });
  let first: Response | undefined;
  for (let i = 0; i < 500; i++) {
    try {
      first = await request("/native-capture-status");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(first, "native status server starts");
  assert.equal(first.status, 200);
  assert.equal((await first.json()).failureCount, 0);
  assert.equal((await (await request("/native-capture-status")).json()).failureCount, 0);
  await assert.rejects(fs.stat(counter), (e: any) => e.code === "ENOENT");
  const metrics = await request("/metrics");
  assert.equal(metrics.status, 503);
  const errorBody = await metrics.text();
  assert.ok(!errorBody.includes("fixture-private-stderr"));
  assert.ok(!errorBody.includes(executable));
  const response = await request("/native-capture-status"),
    status = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(status.runId, "status-run");
  assert.equal(status.failureCount, 1);
  assert.equal(status.failures[0].code, "native_process_exit");
  assert.equal(status.failures[0].exitCode, 7);
  assert.ok(!JSON.stringify(status).includes("fixture-private"));
  assert.equal(await fs.readFile(counter, "utf8"), "1");
  const timingResponse = await request("/native-capture-timing");
  assert.equal(timingResponse.status, 200);
  assert.equal(timingResponse.headers.get("cache-control"), "no-store");
  const timing = await timingResponse.json();
  assert.equal(timing.contractVersion, "measurement-native-capture-timing.v1");
  assert.equal(timing.runId, "status-run");
  assert.deepEqual(
    timing.events.map((event: any) => event.stage),
    ["PROCESS", "EXPOSITION"]
  );
  assert.equal(timing.events[1].httpStatus, 503);
  assert.equal(timing.events[1].collectionGeneration, null);
  assert.ok(!JSON.stringify(timing).includes("fixture-private"));
  assert.equal(
    (await (await request("/native-capture-timing")).json()).eventCount,
    timing.eventCount
  );
  assert.equal(await fs.readFile(counter, "utf8"), "1", "timing reads never acquire data");
  const payload = namedLatchSnapshot();
  payload.latchInventory.runId = "status-run";
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(counter)},'1');process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`,
    { mode: 0o755 }
  );
  const successful = await request("/metrics");
  assert.equal(successful.status, 200);
  assert.ok((await successful.text()).includes("parkbench_openedge_db_latch_named_waits_total"));
  const successTiming = await (await request("/native-capture-timing")).json();
  assert.deepEqual(
    successTiming.events.slice(2).map((event: any) => event.stage),
    ["PROCESS", "NORMALIZE", "CAPTURE", "EXPOSITION"]
  );
  const completed = successTiming.events.at(-2),
    exposed = successTiming.events.at(-1);
  assert.equal(completed.sourceCapturedAtMs, Date.parse(payload.collectedAt));
  assert.equal(exposed.sourceCapturedAtMs, completed.sourceCapturedAtMs);
  assert.equal(
    exposed.collectionGeneration,
    Number(successful.headers.get("x-parkbench-collection-generation"))
  );
  assert.equal(exposed.httpStatus, 200);
  assert.equal(exposed.callerRole, "UNKNOWN");
  assert.equal(exposed.minimumCapturedAtMs, null);
  assert.equal(successTiming.historyComplete, true);
  assert.ok(!JSON.stringify(successTiming).includes('"metrics"'));
  assert.equal(await fs.readFile(counter, "utf8"), "11");
  assert.equal(
    (await (await request("/native-capture-timing")).json()).eventCount,
    successTiming.eventCount
  );
  assert.equal(await fs.readFile(counter, "utf8"), "11");
});
