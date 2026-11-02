import test from "node:test";
import assert from "node:assert/strict";
import { NativeCaptureStatus } from "../../packages/observers/src/openedge-db/native-capture-status";

const capture = { sourceKey: "native-instance", collectionGeneration: 1 };
test("native timing records successful stages, real source time and HTTP exposure without a writer", () => {
  const status: any = new NativeCaptureStatus("owned-run");
  status.observe(capture, {
    stage: "PROCESS",
    outcome: "SUCCEEDED",
    startedAtMs: 1000,
    finishedAtMs: 1800,
    durationMs: 800,
    stdout: "fixture-private-body",
    argv: ["fixture-private-argument"]
  });
  status.observe(capture, {
    stage: "NORMALIZE",
    outcome: "SUCCEEDED",
    startedAtMs: 1800,
    finishedAtMs: 1900,
    durationMs: 100
  });
  status.captureCompleted(capture, 1200, 1900);
  status.exposition({
    callerRole: "UNKNOWN",
    requestedAtMs: 1100,
    finishedAtMs: 2000,
    minimumCapturedAtMs: 1000,
    collectionGeneration: 1,
    sourceCapturedAtMs: 1200,
    httpStatus: 200,
    url: "fixture-private-url",
    headers: { authorization: "fixture-private-token" }
  });
  const timing = status.timingSnapshot();
  assert.equal(timing.contractVersion, "measurement-native-capture-timing.v1");
  assert.equal(timing.runId, "owned-run");
  assert.equal(timing.historyComplete, true);
  assert.deepEqual(
    timing.events.map((e: any) => e.stage),
    ["PROCESS", "NORMALIZE", "CAPTURE", "EXPOSITION"]
  );
  assert.equal(timing.events[2].sourceCapturedAtMs, 1200);
  assert.equal(timing.events[3].minimumCapturedAtMs, 1000);
  assert.equal(timing.events[3].collectionGeneration, 1);
  assert.ok(!JSON.stringify(timing).includes("fixture-private"));
  assert.equal(status.snapshot().failureCount, 0);
  timing.events[0].startedAtMs = 999;
  timing.events.length = 0;
  assert.equal(status.timingSnapshot().events[0].startedAtMs, 1000);
  assert.equal(status.timingSnapshot().events.length, 4);
});

test("native timing stays bounded and reports loss while preserving the separate failure history", () => {
  const status: any = new NativeCaptureStatus("owned-run");
  for (let i = 1; i <= 2000; i++) {
    status.observe(
      { ...capture, collectionGeneration: i },
      {
        stage: "PROCESS",
        outcome: "SUCCEEDED",
        startedAtMs: i,
        finishedAtMs: i + 1,
        durationMs: 1
      }
    );
  }
  const timing = status.timingSnapshot();
  assert.equal(timing.eventCount, 2000);
  assert.ok(timing.retainedEventCount <= 512);
  assert.equal(timing.retainedEventCount + timing.droppedEvents, 2000);
  assert.equal(timing.historyComplete, false);
  assert.ok(timing.events[0].collectionGeneration > 1);
  assert.ok(Buffer.byteLength(JSON.stringify(timing)) <= 128 * 1024);
  assert.equal(status.snapshot().historyComplete, true);
  assert.equal(status.snapshot().failureCount, 0);
});

test("native timing rejects foreign source, invalid source time and malformed request metadata", () => {
  const status: any = new NativeCaptureStatus("owned-run");
  status.observe(capture, {
    stage: "PROCESS",
    outcome: "SUCCEEDED",
    startedAtMs: 1,
    finishedAtMs: 2,
    durationMs: 1
  });
  status.captureCompleted({ sourceKey: "foreign", collectionGeneration: 2 }, 2, 3);
  status.captureCompleted(capture, Number.NaN, 3);
  status.exposition({ callerRole: "private-caller", requestedAtMs: 1, finishedAtMs: 2 });
  const timing = status.timingSnapshot();
  assert.equal(timing.rejectedEvents, 3);
  assert.equal(timing.events.length, 1);
  assert.equal(timing.historyComplete, false);
  assert.ok(!JSON.stringify(timing).includes("foreign"));
  assert.ok(!JSON.stringify(timing).includes("private-caller"));
});
