import { it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseObserverCollection } from "../../packages/observers/src/openedge-db/collection";

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
