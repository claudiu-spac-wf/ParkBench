import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObserverCollector } from "../../packages/observers/src/collector";
import { HttpMetricsObserver } from "../../packages/observers/src/http-observer";
import { phaseSchedule } from "../../apps/control-plane/src/runs/phase-runner";

describe("observer collector phase length", () => {
  it("does not backfill delayed or cancelled scheduled collection", async () => {
    const originalNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    let now = 1_800_000_000_000;
    Date.now = () => now;
    (globalThis as any).setTimeout = (callback: () => void, delay = 0) => {
      now += Number(delay);
      return originalSetTimeout(callback, 0);
    };
    const acquisitions: number[] = [];
    const context = {
      runId: "run",
      experimentId: "exp",
      variantId: "v",
      repetition: 1,
      phase: "measurement"
    };
    const collector = new ObserverCollector(
      [{ id: "core", kind: "core", required: true, samplingIntervalSeconds: 1 }],
      context,
      {
        create: () => ({
          id: "core",
          kind: "core",
          ready: async () => true,
          sample: async () => {
            acquisitions.push(now);
            now += 1500;
            return [];
          }
        })
      }
    );
    try {
      const start = now;
      const [quality] = await collector.collectPhase(context, 4, 1, new Set(), () => false, {
        startMs: start,
        endMs: start + 4000
      });
      assert.deepEqual(acquisitions, [start, start + 2000]);
      assert.equal(quality.observed, 0);
      assert.ok(quality.longestGapSeconds! >= 4);
      await collector.collectPhase({ ...context, phase: "cooldown" }, 2, 1, new Set(), () => true, {
        startMs: now,
        endMs: now + 2000
      });
      await collector.collectPhase({ ...context, phase: "warmup" }, 0, 1, new Set(), () => false, {
        startMs: now,
        endMs: now
      });
      assert.equal(acquisitions.length, 2);
    } finally {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });
  it("keeps scheduled collection cadence through adjacent and zero-length phase boundaries", async () => {
    const originalNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    let now = 1_800_000_000_000;
    Date.now = () => now;
    (globalThis as any).setTimeout = (callback: () => void, delay = 0) => {
      now += Number(delay);
      return originalSetTimeout(callback, 0);
    };
    const acquisitions: number[] = [];
    const context = {
      runId: "run",
      experimentId: "exp",
      variantId: "v",
      repetition: 1,
      phase: "warmup"
    };
    const collector = new ObserverCollector(
      [{ id: "core", kind: "core", required: true, samplingIntervalSeconds: 1 }],
      context,
      {
        create: () => ({
          id: "core",
          kind: "core",
          ready: async () => true,
          sample: async (c) => {
            acquisitions.push(now);
            return [
              {
                metricName: "measured",
                value: now,
                timestamp: now / 1000,
                source: "test",
                labels: {
                  run_id: c.runId,
                  experiment_id: c.experimentId,
                  variant_id: c.variantId,
                  repetition: String(c.repetition),
                  component: "observer",
                  service: "core",
                  phase: c.phase as any
                }
              }
            ];
          }
        })
      }
    );
    try {
      const schedule = phaseSchedule(
        { warmupSeconds: 30, measurementSeconds: 120, cooldownSeconds: 10 },
        now
      );
      for (const timing of schedule)
        await collector.collectPhase(
          { ...context, phase: timing.phase },
          timing.seconds,
          1,
          new Set(),
          () => false,
          timing
        );
      assert.equal(now, schedule.at(-1)!.endMs);
      assert.equal(acquisitions.length, 160);
      assert.equal(schedule.at(-1)!.endMs - schedule[0].startMs, 160000);
      assert.equal(schedule[0].endMs, schedule[1].startMs);
      assert.equal(schedule[1].endMs, schedule[2].startMs);
      for (let i = 1; i < acquisitions.length; i++)
        assert.equal(acquisitions[i] - acquisitions[i - 1], 1000);
      const zero = phaseSchedule(
        { warmupSeconds: 0, measurementSeconds: 1, cooldownSeconds: 0 },
        now
      );
      assert.equal(zero[0].endMs, zero[1].startMs);
      assert.equal(zero[1].endMs, zero[2].startMs);
    } finally {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });
  it("collects for the whole phase when it is longer than 600 s", async () => {
    const metrics = [
      'parkbench_observer_collection_duration_seconds{kind="file_sampler_v1",outcome="success"} 0.001',
      'parkbench_observer_collection_outcomes_total{kind="file_sampler_v1",outcome="success"} 1',
      "parkbench_file_size_bytes 24"
    ].join("\n");
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    // Virtual clock: every timer fires immediately and advances time by its delay.
    let now = 1_800_000_000_000;
    Date.now = () => now;
    (globalThis as any).setTimeout = (callback: () => void, delay = 0) => {
      now += Number(delay) || 0;
      return originalSetTimeout(callback, 0);
    };
    globalThis.fetch = async () => new Response(metrics, { status: 200 });
    try {
      const context = {
        runId: "run-long",
        experimentId: "exp-long",
        variantId: "baseline",
        repetition: 1,
        phase: "measurement"
      };
      const declaration = {
        id: "files",
        kind: "file_sampler_v1",
        required: true,
        samplingIntervalSeconds: 100,
        metrics: ["parkbench_file_size_bytes"],
        configuration: { metricsUrl: "http://observer:9100" }
      };
      const observer = new HttpMetricsObserver(
        declaration.id,
        declaration.kind,
        declaration.configuration.metricsUrl,
        "/metrics",
        1000,
        declaration.metrics
      );
      const collector = new ObserverCollector([declaration], context, { create: () => observer });
      const startedAt = now;
      const [result] = await collector.collectPhase(context, 1080, 1);
      assert.ok(now - startedAt >= 1_080_000, `phase ended after ${(now - startedAt) / 1000} s`);
      assert.equal(result.expected, 11);
      assert.ok(result.observed >= 11, JSON.stringify(result));
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
