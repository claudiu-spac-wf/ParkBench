import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NativeCaptureClock } from "../../packages/observers/src/native-capture-clock";
import { NativeCaptureScheduler } from "../../packages/observers/src/native-capture-scheduler";
import { DatabaseObserverCollection } from "../../packages/observers/src/openedge-db/collection";

function clock(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-cadence-")),
    file = path.join(dir, "clock.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    file,
    JSON.stringify({
      contractVersion: "run-phase-clock.v1",
      runId: "owned",
      continuous: true,
      nativeDatabaseIntervalMs: 5000,
      nativePhases: [
        { phase: "warmup", startMs: 1000, endMs: 4000 },
        { phase: "measurement", startMs: 4000, endMs: 19000 },
        { phase: "cooldown", startMs: 19000, endMs: 21000 }
      ]
    })
  );
  return new NativeCaptureClock(file, "owned");
}
test("source acquisition stays five seconds apart when HTTP arrival moves within source slots", async (t) => {
  const source = clock(t);
  let now = 4000,
    reads = 0;
  const captured: number[] = [];
  const collector = new DatabaseObserverCollection(
    async () => {
      reads++;
      now += 1000;
      captured.push(now);
      return { at: now };
    },
    10000,
    () => now,
    undefined,
    (p) => p.at
  );
  const scheduler = new NativeCaptureScheduler(
    source,
    (slot) => collector.metricsWithEvidence({ callerRole: "UNKNOWN", minimumCapturedAtMs: slot }),
    () => now
  );
  assert.equal(await scheduler.poll(), 4000);
  now = 6500;
  const a = await collector.metricsWithEvidence({
    callerRole: "CONTROLLER",
    minimumCapturedAtMs: 4000
  });
  now = 9000;
  await scheduler.poll();
  now = 14500;
  const b = await collector.metricsWithEvidence({
    callerRole: "SCRAPER",
    minimumCapturedAtMs: source.minimumCapturedAtMs(now)
  });
  assert.deepEqual(captured, [5000, 10000, 15500]);
  // Delaying that HTTP request into the next slot honestly requires a new point.
  assert.equal(a.capturedAtMs, 5000);
  assert.equal(b.capturedAtMs, 15500);
  assert.equal(reads, 3);
  await scheduler.close();
});
test("late HTTP arrival no longer determines source time within a slot", async (t) => {
  const source = clock(t);
  let requestTime = 4000;
  const demandOnly = new DatabaseObserverCollection(
    async () => ({ at: requestTime + 1000 }),
    10000,
    () => requestTime,
    undefined,
    (p) => p.at
  );
  const first = await demandOnly.metricsWithEvidence({
    callerRole: "CONTROLLER",
    minimumCapturedAtMs: 4000
  });
  requestTime = 12000;
  const delayed = await demandOnly.metricsWithEvidence({
    callerRole: "SCRAPER",
    minimumCapturedAtMs: 9000
  });
  assert.equal(
    delayed.capturedAtMs! - first.capturedAtMs!,
    8000,
    "reproduce the failing on-demand trace without changing source timestamps"
  );
  let now = 4000,
    reads = 0;
  const collector = new DatabaseObserverCollection(
    async () => {
      reads++;
      now += 1000;
      return { at: now };
    },
    10000,
    () => now,
    undefined,
    (p) => p.at
  );
  // On-demand-only trace: requests at4000 and12000 produce5000 and13000: an8000ms gap.
  const scheduler = new NativeCaptureScheduler(
    source,
    (slot) => collector.metricsWithEvidence({ callerRole: "UNKNOWN", minimumCapturedAtMs: slot }),
    () => now
  );
  await scheduler.poll();
  now = 9000;
  await scheduler.poll();
  now = 12000;
  const response = await collector.metricsWithEvidence({
    callerRole: "SCRAPER",
    minimumCapturedAtMs: source.minimumCapturedAtMs(now)
  });
  assert.equal(response.capturedAtMs, 10000);
  assert.equal(reads, 2);
  assert.ok(response.capturedAtMs! - 5000 <= 7500);
  await scheduler.close();
});
test("future phases, non-aligned boundaries and expired schedules never create catch-up observations", async (t) => {
  const source = clock(t);
  let now = 0;
  const starts: number[] = [];
  const scheduler = new NativeCaptureScheduler(
    source,
    async (slot) => {
      starts.push(slot);
      now += 100;
    },
    () => now
  );
  assert.equal(await scheduler.poll(), 1000);
  assert.deepEqual(starts, []);
  now = 1000;
  await scheduler.poll();
  now = 4000;
  await scheduler.poll();
  now = 17500;
  await scheduler.poll();
  now = 19000;
  await scheduler.poll();
  now = 22000;
  await scheduler.poll();
  assert.deepEqual(starts, [1000, 4000, 14000, 19000]);
  await scheduler.close();
});
test("failed acquisition is not retried by the scheduler within its slot and close joins pending work", async (t) => {
  const source = clock(t);
  let now = 4000,
    attempts = 0;
  let release!: () => void;
  const scheduler = new NativeCaptureScheduler(
    source,
    async () => {
      attempts++;
      if (attempts === 1) throw Error("unavailable");
      await new Promise<void>((r) => (release = r));
    },
    () => now
  );
  await scheduler.poll();
  await scheduler.poll();
  assert.equal(attempts, 1);
  now = 9000;
  const active = scheduler.poll();
  await Promise.resolve();
  const second = scheduler.poll();
  let closed = false;
  const close = scheduler.close().then(() => (closed = true));
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await Promise.all([active, second, close]);
  now = 14000;
  await scheduler.poll();
  assert.equal(attempts, 2);
});
