import { it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseObserverCollection } from "../../packages/observers/src/openedge-db/collection";

it("a real current-slot capture is shared rather than replaced with a later point that opens a coverage gap", async () => {
  let clock = 10000,
    reads = 0,
    finish!: (p: { at: number }) => void;
  const collector = new DatabaseObserverCollection(
    async () => {
      reads++;
      if (reads === 1)
        return new Promise<{ at: number }>((resolve) => {
          finish = resolve;
        });
      clock = 14500;
      return { at: 14050 };
    },
    10000,
    () => clock,
    undefined,
    (p) => p.at
  );
  const first = collector.metricsWithEvidence({
    callerRole: "CONTROLLER",
    minimumCapturedAtMs: 10000
  });
  await Promise.resolve();
  clock = 12400;
  const scraper = collector.metricsWithEvidence({
    callerRole: "UNKNOWN",
    minimumCapturedAtMs: 10000
  });
  clock = 12814;
  finish({ at: 11269 });
  const [a, b] = await Promise.all([first, scraper]);
  assert.equal(b.capturedAtMs, 11269);
  assert.equal(b.collectionId, a.collectionId);
  assert.equal(reads, 1);
  assert.ok(
    b.capturedAtMs! - 6395 <= 7500,
    "independent native trace oracle: previous source6395 must not be followed by replacement14050"
  );
});

it("completed current-slot evidence keeps its actual timestamp and a new source slot requires a real new capture", async () => {
  let clock = 10000,
    reads = 0;
  const collector = new DatabaseObserverCollection(
    async () => {
      reads++;
      return { at: clock + 1269, value: reads };
    },
    10000,
    () => clock,
    undefined,
    (p) => p.at
  );
  const original = await collector.metricsWithEvidence({
    callerRole: "CONTROLLER",
    minimumCapturedAtMs: 10000
  });
  clock = 12950;
  const same = await collector.metricsWithEvidence({
    callerRole: "SCRAPER",
    minimumCapturedAtMs: 10000
  });
  assert.equal(same.collectionId, original.collectionId);
  assert.equal(same.capturedAtMs, 11269);
  assert.equal(same.payload.value, 1);
  assert.equal(reads, 1);
  clock = 15000;
  const next = await collector.metricsWithEvidence({
    callerRole: "UNKNOWN",
    minimumCapturedAtMs: 15000
  });
  assert.equal(next.payload.value, 2);
  assert.ok(next.capturedAtMs! >= 15000);
  assert.notEqual(next.collectionId, original.collectionId);
});

it("a phase boundary excludes a pending pre-phase point and unknown source time never becomes a cached slot", async () => {
  let clock = 14000,
    reads = 0,
    finish!: (p: { at: number | null }) => void;
  const collector = new DatabaseObserverCollection(
    async () => {
      reads++;
      if (reads === 1)
        return new Promise<{ at: number | null }>((resolve) => {
          finish = resolve;
        });
      return { at: reads === 2 ? 17500 : null };
    },
    10000,
    () => clock,
    undefined,
    (p) => p.at
  );
  const warm = collector.metricsWithEvidence({
    callerRole: "CONTROLLER",
    minimumCapturedAtMs: 10000
  });
  await Promise.resolve();
  clock = 15050;
  const measure = collector.metricsWithEvidence({
    callerRole: "SCRAPER",
    minimumCapturedAtMs: 15000
  });
  clock = 16000;
  finish({ at: 14700 });
  await warm;
  assert.equal((await measure).capturedAtMs, 17500);
  clock = 20000;
  assert.equal(
    (await collector.metricsWithEvidence({ callerRole: "SCRAPER", minimumCapturedAtMs: 20000 }))
      .capturedAtMs,
    null
  );
  clock = 21000;
  assert.equal(
    (await collector.metricsWithEvidence({ callerRole: "SCRAPER", minimumCapturedAtMs: 20000 }))
      .capturedAtMs,
    null
  );
  assert.equal(reads, 4);
});

it("every scrape collects a new timestamp across phase and timer alignment changes", async () => {
  let clock = 0,
    reads = 0;
  const collector = new DatabaseObserverCollection(
    async () => {
      reads++;
      clock += reads % 2 ? 100 : 50; // Variable native collection cost.
      return { collectedAt: clock, value: reads };
    },
    10000,
    () => clock
  );
  await collector.health();
  const timestamps: number[] = [];
  // A health refresh just before a scrape must not cause it to reuse old evidence.
  for (const scrape of [5000, 10000, 15000, 30000, 35000, 150000, 155000]) {
    clock = scrape - 20;
    await collector.health();
    clock = scrape;
    const payload = await collector.metrics();
    assert.ok(payload.collectedAt >= scrape);
    timestamps.push(payload.collectedAt);
  }
  assert.equal(new Set(timestamps).size, timestamps.length);
});

it("shares an in-flight native request between scrapes and health checks", async () => {
  let complete!: (value: { collectedAt: number }) => void,
    reads = 0;
  const collector = new DatabaseObserverCollection(() => {
    reads++;
    return new Promise<{ collectedAt: number }>((resolve) => {
      complete = resolve;
    });
  }, 10000);
  const first = collector.metrics(),
    second = collector.metrics(),
    health = collector.health();
  assert.equal(first, second);
  assert.equal(first, health);
  await Promise.resolve();
  assert.equal(reads, 1);
  complete({ collectedAt: 123 });
  const values = await Promise.all([first, second, health]);
  assert.deepEqual(values, Array(3).fill({ collectedAt: 123 }));
  assert.deepEqual(await collector.health(), { collectedAt: 123 });
  assert.equal(reads, 1);
});

it("reports a failed fresh scrape instead of replaying cached success and retries later", async () => {
  let calls = 0,
    clock = 0;
  const collector = new DatabaseObserverCollection(
    async () => {
      calls++;
      if (calls === 2) throw new Error("native_collection_failed");
      return { collectedAt: calls };
    },
    10000,
    () => clock
  );
  assert.deepEqual(await collector.metrics(), { collectedAt: 1 });
  await assert.rejects(collector.metrics(), /native_collection_failed/);
  clock = 10001;
  assert.deepEqual(await collector.health(), { collectedAt: 3 });
  assert.equal(calls, 3);
});

it("a later scrape does not reuse an in-flight capture whose source time precedes that scrape", async () => {
  let clock = 1000,
    reads = 0;
  let finish!: (value: { collectedAt: number; value: number }) => void;
  const collector = new DatabaseObserverCollection(
    async () => {
      reads++;
      if (reads === 1)
        return new Promise<{ collectedAt: number; value: number }>((resolve) => {
          finish = resolve;
        });
      clock += 100;
      return { collectedAt: clock, value: 20 };
    },
    10000,
    () => clock,
    undefined,
    (payload) => payload.collectedAt
  );
  const first = collector.metricsWithEvidence({ callerRole: "SCRAPER" });
  await Promise.resolve();
  // The source has already captured this reading, but normalization/output is still in flight.
  clock = 2000;
  const later = collector.metricsWithEvidence({ callerRole: "CONTROLLER" });
  finish({ collectedAt: 1500, value: 10 });
  const [original, fresh] = await Promise.all([first, later]);
  assert.equal(original.payload.value, 10);
  assert.equal(original.capturedAtMs, 1500);
  assert.equal(fresh.payload.value, 20);
  assert.ok(fresh.capturedAtMs! >= 2000);
  assert.equal(fresh.collectionGeneration, original.collectionGeneration + 1);
  assert.equal(reads, 2);
});

it("requests arriving before the shared source capture retain one real generation regardless of caller role", async () => {
  let clock = 1000,
    reads = 0,
    finish!: (value: { at: number }) => void;
  const collector = new DatabaseObserverCollection(
    () => {
      reads++;
      return new Promise<{ at: number }>((r) => (finish = r));
    },
    10000,
    () => clock,
    undefined,
    (p) => p.at
  );
  const a = collector.metricsWithEvidence({ callerRole: "CONTROLLER" });
  await Promise.resolve();
  clock = 1500;
  const b = collector.metricsWithEvidence({ callerRole: "UNKNOWN" });
  clock = 2000;
  finish({ at: 2000 });
  const values = await Promise.all([a, b]);
  assert.equal(reads, 1);
  assert.equal(values[0].collectionId, values[1].collectionId);
  assert.deepEqual(
    values.map((v) => v.capturedAtMs),
    [2000, 2000]
  );
});

it("unknown source time stays unknown and shared failures propagate without a refresh or cached replay", async () => {
  let reads = 0,
    clock = 1000,
    finish!: (value: { at: null }) => void;
  const collector = new DatabaseObserverCollection(
    async () => {
      reads++;
      if (reads > 1) throw Error("fresh_failure");
      return new Promise<{ at: null }>((r) => (finish = r));
    },
    10000,
    () => clock,
    undefined,
    (p) => p.at
  );
  const a = collector.metricsWithEvidence();
  await Promise.resolve();
  clock = 2000;
  const b = collector.metricsWithEvidence();
  finish({ at: null });
  const values = await Promise.all([a, b]);
  assert.equal(reads, 1);
  assert.deepEqual(
    values.map((v) => v.capturedAtMs),
    [null, null]
  );
  await assert.rejects(collector.metricsWithEvidence(), /fresh_failure/);
  assert.equal(reads, 2);
});

it("stale sharing refresh failure is visible while the original caller retains its actual result", async () => {
  let reads = 0,
    clock = 1000,
    finish!: (value: { at: number }) => void;
  const collector = new DatabaseObserverCollection(
    async () => {
      if (++reads > 1) throw Error("fresh_failure");
      return new Promise<{ at: number }>((r) => (finish = r));
    },
    10000,
    () => clock,
    undefined,
    (p) => p.at
  );
  const a = collector.metricsWithEvidence();
  await Promise.resolve();
  clock = 2000;
  const b = collector.metricsWithEvidence();
  finish({ at: 1500 });
  assert.equal((await a).capturedAtMs, 1500);
  await assert.rejects(b, /fresh_failure/);
  assert.equal(reads, 2);
});
