import test from "node:test";
import assert from "node:assert/strict";
import { ObserverCollector } from "../../packages/observers/src/collector";
for (const observers of [false, true])
  test(`workload supervision polls within five seconds without changing slow/disabled observer sampling: ${observers}`, async () => {
    const originalNow = Date.now,
      originalTimer = globalThis.setTimeout;
    let now = 1800000000000,
      checks = 0,
      samples = 0;
    Date.now = () => now;
    (globalThis as any).setTimeout = (fn: any, delay = 0) => {
      now += Number(delay);
      return originalTimer(fn, 0);
    };
    const evidence: any[] = [];
    const context: any = {
      runId: "owned",
      experimentId: "ex",
      variantId: "v",
      repetition: 1,
      measurementEvidence: {
        diagnosticAttemptId: "fixture",
        record: (e: any) => {
          evidence.push(e);
        }
      },
      phase: "measurement"
    };
    const declarations = observers
      ? [{ id: "slow", kind: "core", required: false, samplingIntervalSeconds: 60 }]
      : [];
    const collector = new ObserverCollector(declarations, context, {
      create: () => ({
        id: "slow",
        kind: "core",
        ready: async () => true,
        sample: async () => {
          samples++;
          return [];
        }
      })
    });
    try {
      await assert.rejects(
        collector.collectPhase(
          context,
          20,
          1,
          new Set(),
          () => false,
          { startMs: now, endMs: now + 20000 },
          async () => {
            if (++checks === 2) throw Error("loadgen_exited_early");
          }
        ),
        /loadgen_exited_early/
      );
      assert.equal(checks, 2);
      assert.ok(
        evidence.every((e) => e.scheduledAtMs === null || Number.isFinite(e.scheduledAtMs))
      );
      assert.equal(now, 1800000005000);
      assert.equal(samples, observers ? 1 : 0);
    } finally {
      Date.now = originalNow;
      globalThis.setTimeout = originalTimer;
    }
  });
