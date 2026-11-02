import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { phaseSchedule } from "../../apps/control-plane/src/runs/phase-runner";
import { NativeCaptureClock } from "../../packages/observers/src/native-capture-clock";
import { DatabaseObserverCollection } from "../../packages/observers/src/openedge-db/collection";

async function observeNativeSources(align: boolean, delayed: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-native-clock-"));
  const runId = "native-alignment-fixture",
    cadenceMs = 5000;
  const lastScrapeAtMs = 1_000_000,
    readyAtMs = lastScrapeAtMs + 500;
  const phases = { warmupSeconds: 60, measurementSeconds: 180, cooldownSeconds: 30 };
  const schedule = (phaseSchedule as any)(
    phases,
    readyAtMs,
    1,
    align ? { lastScrapeAtMs, cadenceMs } : undefined
  ) as ReturnType<typeof phaseSchedule>;
  const warm = schedule[0],
    measure = schedule[1],
    cool = schedule[2];
  const clockFile = path.join(root, "phase-clock.json");
  fs.writeFileSync(
    clockFile,
    JSON.stringify({
      contractVersion: "run-phase-clock.v1",
      runId,
      continuous: true,
      nativeDatabaseIntervalMs: cadenceMs,
      nativePhases: schedule.map(({ phase, startMs, endMs }) => ({ phase, startMs, endMs }))
    })
  );
  const clock = new NativeCaptureClock(clockFile, runId);
  let now = warm.startMs,
    controllerResponses = 0,
    scrapeResponses = 0;
  const captured: Array<{ generation: number; capturedAtMs: number }> = [];
  const exposed = new Set<number>(),
    scrapeDurations: number[] = [];
  const pending: Promise<unknown>[] = [];
  const events: Array<{ at: number; execute: () => void }> = [];
  const collection = new DatabaseObserverCollection(
    ({ collectionGeneration }) =>
      new Promise<{ generation: number; capturedAtMs: number }>((resolve) => {
        events.push({
          at: now + 1000,
          execute: () => {
            const frame = { generation: collectionGeneration, capturedAtMs: now };
            captured.push(frame);
            resolve(frame);
          }
        });
      }),
    cadenceMs,
    () => now,
    undefined,
    (frame) => frame.capturedAtMs
  );
  const request = (role: "CONTROLLER" | "SCRAPER", assignedAtMs = now) => {
    pending.push(
      collection
        .metricsWithEvidence({
          callerRole: role,
          minimumCapturedAtMs: clock.minimumCapturedAtMs(now)
        })
        .then(({ payload }) => {
          if (role === "CONTROLLER") controllerResponses++;
          else {
            scrapeResponses++;
            exposed.add(payload.capturedAtMs);
            scrapeDurations.push(now - assignedAtMs);
          }
        })
    );
  };
  for (let at = warm.startMs; at < cool.endMs; at += cadenceMs)
    events.push({ at, execute: () => request("CONTROLLER") });
  const firstScrape =
    lastScrapeAtMs + Math.ceil((warm.startMs - lastScrapeAtMs) / cadenceMs) * cadenceMs;
  for (let at = firstScrape; at < cool.endMs; at += cadenceMs) {
    const assignedAtMs = at;
    const slot = Math.floor((at - measure.startMs) / cadenceMs);
    // Existing successful-scrape failure: two 800ms admissions cross an interval
    // boundary when the real scraper is near its tail. No process/HTTP fails.
    const admissionDelay = delayed && (slot === 12 || slot === 14) ? 800 : 0;
    events.push({ at: at + admissionDelay, execute: () => request("SCRAPER", assignedAtMs) });
  }
  try {
    while (events.length) {
      events.sort((a, b) => a.at - b.at);
      const event = events.shift()!;
      now = event.at;
      event.execute();
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    }
    await Promise.all(pending);
    const measurement = captured.filter(
      (c) => c.capturedAtMs >= measure.startMs && c.capturedAtMs < measure.endMs
    );
    const unpublished = measurement.filter((c) => !exposed.has(c.capturedAtMs));
    return {
      schedule,
      readyAtMs,
      firstScrape,
      controllerResponses,
      scrapeResponses,
      captured: captured.length,
      measurement: measurement.length,
      stored: measurement.length - unpublished.length,
      unpublishedSlots: unpublished.map((c) =>
        Math.floor((c.capturedAtMs - measure.startMs) / cadenceMs)
      ),
      scrapeDurations,
      warm,
      measure,
      cool
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("native phase scheduling preserves every real source generation across delayed successful scrapes", async () => {
  const r = await observeNativeSources(true, true);
  assert.equal(r.controllerResponses, 54);
  assert.equal(r.scrapeResponses, 54);
  assert.equal(r.captured, 54);
  assert.equal(r.measurement, 36);
  assert.ok(
    r.scrapeDurations.every((d) => d < 5000),
    "unchanged scrape deadlines all succeed"
  );
  assert.equal(r.stored, 36, "every actually captured measurement generation must be exposed");
  assert.deepEqual(r.unpublishedSlots, []);
  assert.ok(r.warm.startMs >= r.readyAtMs, "alignment never starts work before readiness");
  assert.ok(r.warm.startMs - r.readyAtMs < 5000, "only bounded pre-warmup wait is added");
  assert.equal(r.measure.endMs - r.measure.startMs, 180000);
  assert.equal(r.cool.endMs - r.warm.startMs, 270000);
  assert.equal(r.warm.endMs, r.measure.startMs);
  assert.equal(r.measure.endMs, r.cool.startMs);
});

test("unaligned source-clock oracle reproduces two unpublished generations with complete controllers and successful scrapes", async () => {
  const r = await observeNativeSources(false, true);
  assert.equal(r.controllerResponses, 54);
  assert.equal(r.scrapeResponses, 54);
  assert.equal(r.captured, 54);
  assert.equal(r.measurement, 36);
  assert.equal(r.stored, 34);
  assert.deepEqual(r.unpublishedSlots, [12, 14]);
  assert.ok(r.scrapeDurations.every((d) => d < 5000));
});

test("the same unaligned collector is complete without the delayed-admission trigger", async () => {
  const r = await observeNativeSources(false, false);
  assert.equal(r.measurement, 36);
  assert.equal(r.stored, 36);
  assert.deepEqual(r.unpublishedSlots, []);
});

test("measurement origin stays aligned when warmup is not a whole number of source intervals", () => {
  const readyAtMs = 1000500,
    cadenceMs = 5000,
    lastScrapeAtMs = 1000000;
  const phases = { warmupSeconds: 61, measurementSeconds: 181, cooldownSeconds: 31 };
  const schedule = (phaseSchedule as any)(phases, readyAtMs, 1, { lastScrapeAtMs, cadenceMs });
  const measurementStart = schedule[1].startMs;
  const nextScrape =
    lastScrapeAtMs + Math.ceil((measurementStart - lastScrapeAtMs) / cadenceMs) * cadenceMs;
  assert.equal(nextScrape - measurementStart, 250);
  assert.equal(schedule[0].endMs - schedule[0].startMs, 61000);
  assert.equal(schedule[1].endMs - schedule[1].startMs, 181000);
  assert.equal(schedule[2].endMs - schedule[2].startMs, 31000);
  assert.ok(schedule[0].startMs >= readyAtMs && schedule[0].startMs - readyAtMs < cadenceMs);
});

test("legacy schedules retain their original origin and invalid supplied clocks cannot fabricate an alignment", () => {
  const phases = { warmupSeconds: 60, measurementSeconds: 180, cooldownSeconds: 30 };
  assert.equal(phaseSchedule(phases, 1000500)[0].startMs, 1000500);
  for (const clock of [
    { lastScrapeAtMs: NaN, cadenceMs: 5000 },
    { lastScrapeAtMs: 2000000, cadenceMs: 5000 },
    { lastScrapeAtMs: 1000000, cadenceMs: 0 }
  ])
    assert.throws(
      () => (phaseSchedule as any)(phases, 1000500, 1, clock),
      /native_scrape_clock_invalid/
    );
});
