import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import type { Run } from "../../packages/contracts/src/run";

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-queue-continuation-"));
  const orchestrator = new FakeRunOrchestrator();
  // These tests exercise dispatch and lifecycle handoff, never benchmark execution.
  t.mock.method(orchestrator, "provision", async () => {
    assert.fail("queue tests must not provision benchmark resources");
  });
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://127.0.0.1:9090",
      prometheusRetention: "7d",
      openedge: {}
    },
    { testMode: true, orchestrator }
  );
  await platform.startupRecovery;
  platform.scenarios.register(scenario);
  const preflight = t.mock.method(platform.controlUi as any, "preflightExperiment", async () => {});
  const started: Run[] = [];
  const finish = (run: Run, state: Run["state"] = "SUCCEEDED") => {
    run.state = state;
    run.measurementValidity =
      state === "SUCCEEDED" ? "VALID" : state === "INCOMPLETE" ? "INCOMPLETE" : "UNAVAILABLE";
    run.cleanupStatus = "COMPLETE";
    run.finishedAt = new Date().toISOString();
    platform.repositories.saveRun(run);
    return run;
  };
  const execute = t.mock.method(platform.coordinator, "executeRun", async (run: Run) => {
    started.push(run);
    return finish(run);
  });
  const submit = (name: string, repetitions = 1) => {
    const preview = platform.controlUi.preview({
      runName: name,
      scenario: { id: scenario.id, version: scenario.version },
      dimensions: [{ name: "-B", values: [500] }],
      repetitions
    });
    return platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
  };
  t.after(() => {
    assert.deepEqual(orchestrator.calls, [], "no orchestration or workload calls are allowed");
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { platform, preflight, started, execute, finish, submit };
}

async function eventually(check: () => boolean) {
  for (let turn = 0; turn < 100 && !check(); turn++) await setImmediate();
  assert.ok(check(), "queue did not make the expected progress");
}

test("one explicit start drains experiments and repetitions in FIFO order without overlap", async (t) => {
  const f = await fixture(t);
  const first = f.submit("First", 2);
  const second = f.submit("Second");
  const third = f.submit("Third");
  const pending: Array<{ run: Run; resolve: (run: Run) => void }> = [];
  let active = 0;
  let maxActive = 0;
  f.execute.mock.mockImplementation(async (run: Run) => {
    f.started.push(run);
    maxActive = Math.max(maxActive, ++active);
    return new Promise<Run>((resolve) => pending.push({ run, resolve }));
  });
  await setImmediate();
  assert.equal(f.started.length, 0, "submitting work must not start it");
  assert.equal((await f.platform.controlUi.startQueue()).started, first.id);
  const expected = [...first.runs, ...second.runs, ...third.runs].map((run) => run.id);
  for (let index = 0; index < expected.length; index++) {
    await eventually(() => pending.length === 1);
    assert.equal(pending[0].run.id, expected[index]);
    assert.equal(
      (await f.platform.controlUi.startQueue()).activeExperiment,
      pending[0].run.experimentId
    );
    const item = pending.shift()!;
    active--;
    item.resolve(f.finish(item.run));
  }
  await eventually(() => f.platform.repositories.getExperiment(third.id)?.status !== "RUNNING");
  assert.deepEqual(
    f.started.map((run) => run.id),
    expected
  );
  assert.equal(maxActive, 1);
  assert.deepEqual(f.platform.controlUi.listQueue(), []);
  assert.equal(f.preflight.mock.callCount(), 3);
});

for (const state of ["SUCCEEDED", "FAILED", "CANCELLED", "INCOMPLETE"] as const) {
  test(`immediate ${state} completion wakes the next experiment even during overlapping starts`, async (t) => {
    const f = await fixture(t);
    const first = f.submit("Immediate First");
    const second = f.submit("Immediate Second");
    f.execute.mock.mockImplementation(async (run: Run) => {
      f.started.push(run);
      return f.finish(run, run.experimentId === first.id ? state : "SUCCEEDED");
    });
    const responses = await Promise.all([
      f.platform.controlUi.startQueue(),
      f.platform.controlUi.startQueue(),
      f.platform.controlUi.startQueue()
    ]);
    assert.ok(responses.every((response) => response.started === first.id));
    await eventually(() => f.started.length === 2);
    await eventually(() => f.platform.repositories.getExperiment(second.id)?.status !== "RUNNING");
    assert.deepEqual(
      f.started.map((run) => run.id),
      [first.runs[0].id, second.runs[0].id]
    );
    assert.equal(f.preflight.mock.callCount(), 2);
  });
}

test("completion outside an explicitly started queue leaves queued work untouched", async (t) => {
  const f = await fixture(t);
  const direct = f.submit("Direct Start");
  const queued = f.submit("Not Started");
  f.platform.coordinator.startExperiment(direct.id);
  await eventually(() => f.platform.repositories.getExperiment(direct.id)?.status !== "RUNNING");
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  assert.deepEqual(
    f.started.map((run) => run.id),
    [direct.runs[0].id]
  );
  assert.equal(f.platform.repositories.getExperiment(queued.id)?.status, "QUEUED");
  assert.equal(f.preflight.mock.callCount(), 0);
});

test("an empty queue requires another explicit start for subsequently submitted work", async (t) => {
  const f = await fixture(t);
  const first = f.submit("Drain First");
  await f.platform.controlUi.startQueue();
  await eventually(() => f.platform.repositories.getExperiment(first.id)?.status !== "RUNNING");
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  const direct = f.submit("Later Direct Start");
  const queued = f.submit("Later Queued");
  f.platform.coordinator.startExperiment(direct.id);
  await eventually(() => f.platform.repositories.getExperiment(direct.id)?.status !== "RUNNING");
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  assert.equal(f.platform.repositories.getExperiment(queued.id)?.status, "QUEUED");
  await f.platform.controlUi.startQueue();
  await eventually(() => f.platform.repositories.getExperiment(queued.id)?.status !== "RUNNING");
  assert.deepEqual(
    f.started.map((run) => run.experimentId),
    [first.id, direct.id, queued.id]
  );
});

test("continuation retains preflight blocking and does not spin on ineligible work", async (t) => {
  const f = await fixture(t);
  const first = f.submit("Eligible");
  const blocked = f.submit("Blocked");
  f.preflight.mock.mockImplementation(async (record: { id: string }) => {
    if (record.id === blocked.id) throw new Error("scenario_configuration_invalid");
  });
  await f.platform.controlUi.startQueue();
  await eventually(() => f.platform.controlUi.getExperiment(blocked.id)?.status === "BLOCKED");
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  assert.deepEqual(
    f.started.map((run) => run.id),
    [first.runs[0].id]
  );
  assert.equal(f.preflight.mock.callCount(), 2);
  assert.match(
    f.platform.controlUi.listQueue()[0].blockedReason!,
    /scenario_configuration_invalid/
  );
});

test("continuation retains temporary-capacity backoff and resumes after recovery", async (t) => {
  const f = await fixture(t);
  const first = f.submit("Capacity First");
  const next = f.submit("Capacity Next");
  let busy = true;
  f.preflight.mock.mockImplementation(async (record: { id: string }) => {
    if (record.id === next.id && busy) throw new Error("temporary capacity busy");
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  await f.platform.controlUi.startQueue();
  await eventually(() => Boolean(f.platform.controlUi.listQueue()[0]?.nextRetryAt));
  assert.deepEqual(
    f.started.map((run) => run.id),
    [first.runs[0].id]
  );
  const queued = f.platform.controlUi.listQueue()[0];
  assert.equal(queued.id, next.runs[0].id);
  assert.equal(queued.queueState, "QUEUED");
  assert.equal(queued.retryCount, 1);
  busy = false;
  t.mock.timers.tick(4_999);
  assert.equal(f.started.length, 1);
  t.mock.timers.tick(1);
  await eventually(() => f.started.length === 2);
  await eventually(() => f.platform.repositories.getExperiment(next.id)?.status !== "RUNNING");
  assert.deepEqual(f.platform.controlUi.listQueue(), []);
});

test("closing during a completion preflight prevents dispatch after shutdown", async (t) => {
  const f = await fixture(t);
  f.submit("Shutdown First");
  const next = f.submit("Shutdown Next");
  let reachedPreflight = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.preflight.mock.mockImplementation(async (record: { id: string }) => {
    if (record.id === next.id) {
      reachedPreflight = true;
      await gate;
    }
  });
  await f.platform.controlUi.startQueue();
  await eventually(() => reachedPreflight);
  f.platform.controlUi.close();
  release();
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  assert.equal(f.started.length, 1);
  assert.equal(f.platform.repositories.getExperiment(next.id)?.status, "QUEUED");
});

test("closing removes capacity retry timers", async (t) => {
  const f = await fixture(t);
  f.submit("Shutdown Retry");
  f.preflight.mock.mockImplementation(async () => {
    throw new Error("temporary capacity busy");
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  await f.platform.controlUi.startQueue();
  assert.equal(f.preflight.mock.callCount(), 1);
  f.platform.controlUi.close();
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(f.preflight.mock.callCount(), 1);
  assert.deepEqual(f.started, []);
});
