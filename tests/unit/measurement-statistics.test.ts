import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { measurementStatistics } from "../../packages/metrics/src/measurement-statistics";
import { resolveMeasurementWindow } from "../../packages/metrics/src/measurement-window";
const vectors = JSON.parse(
  fs.readFileSync("tests/fixtures/metrics/measurement-reference-v1.json", "utf8")
).vectors;
const observations = (v: any[]) =>
  v.map(([timestamp, value, epoch]) => ({ timestamp, value, epoch }));
describe("independent measurement math", () => {
  it("accounts for known source timestamp age only at measurement edges", () => {
    const series = {
      cadenceSeconds: 5,
      observations: observations([
        [0, 0],
        [5, 5],
        [10, 10]
      ])
    };
    const window = { start: 0, end: 15.25 };
    const options = { type: "counter" as const, unit: "ops/s", totalUnit: "ops" };
    assert.equal(measurementStatistics([series], window, options).coverage.missingSeconds, 5.25);
    const timed = { ...series, acquisitionLagSeconds: 1 };
    const complete = measurementStatistics([timed], window, options);
    assert.equal(complete.coverage.missingSeconds, 0);
    assert.equal(complete.coverage.observedSeconds, 10);
    assert.equal(complete.coverage.estimatedEdgeSeconds, 5.25);
    assert.equal(complete.statistics.total?.estimatedTotal, 5.25);
    assert.equal(
      measurementStatistics([timed], { start: 0, end: 16.25 }, options).coverage.missingSeconds,
      6.25
    );
    const gap = {
      ...timed,
      observations: observations([
        [0, 0],
        [5, 5],
        [15, 15],
        [20, 20]
      ])
    };
    assert.equal(
      measurementStatistics([gap], { start: 0, end: 25.25 }, options).coverage.missingSeconds,
      10
    );
    const outside = {
      ...timed,
      observations: [...timed.observations, { timestamp: 16, value: 10000 }]
    };
    assert.deepEqual(measurementStatistics([outside], window, options), complete);
  });
  for (const id of [
    "uneven-gauge",
    "steady-counter",
    "cpu-one-core",
    "reset",
    "fractional-bins",
    "short-counter",
    "observed-zero",
    "missing",
    "phase-spikes",
    "epoch-gap"
  ])
    it(id, () => {
      const v = vectors.find((x) => x.id === id);
      const r = measurementStatistics(
        [{ observations: observations(v.observations), cadenceSeconds: v.cadence }],
        { start: v.window[0], end: v.window[1] },
        {
          type: v.kind,
          scale: v.scale ?? 1,
          totalScale: v.totalScale ?? 1,
          allowExactEnd: v.exactEnd,
          unit: "fixture",
          totalUnit: "activity"
        }
      );
      for (const key of ["average", "p90", "p95", "total"])
        if (key in v.expected) {
          if (v.expected[key] === null) assert.equal(r.statistics[key]?.value ?? null, null);
          else
            assert.ok(
              Math.abs(r.statistics[key].value - v.expected[key]) < 1e-8,
              `${key}: ${r.statistics[key]?.value} != ${v.expected[key]}`
            );
        }
      if (v.expected.missingSeconds !== undefined)
        assert.equal(r.coverage.missingSeconds, v.expected.missingSeconds);
    });
  it("separates additive partial totals from contemporaneous means", () => {
    const v = vectors.find((x) => x.id === "staggered-members");
    const r = measurementStatistics(
      v.members.map((m) => ({ observations: observations(m), cadenceSeconds: 1 })),
      { start: 0, end: 10 },
      {
        type: "counter",
        unit: "operations_per_second",
        totalUnit: "operations",
        allowExactEnd: true,
        constituentSelector: {
          definitionIds: ["db.table.read"],
          group: "database",
          coverageScope: "table_covered"
        }
      }
    );
    assert.equal(r.statistics.total.value, 15);
    assert.equal(r.statistics.average.value, 2);
    assert.equal(r.statistics.total.status, "partial");
    assert.equal(r.statistics.total.coverage.coverageModel, "constituent_additive");
    assert.equal(r.coverage.observedSeconds, 5);
  });
  it("aggregates member spikes before percentiles", () => {
    const v = vectors.find((x) => x.id === "member-spikes");
    const r = measurementStatistics(
      v.members.map((m) => ({ observations: observations(m), cadenceSeconds: 1 })),
      { start: 0, end: 4 },
      { type: "gauge", unit: "bytes" }
    );
    assert.equal(r.statistics.average.value, 5);
    assert.equal(r.statistics.p90.value, 10);
  });
  it("does not estimate internal gaps or import the first epoch counter level", () => {
    const r = measurementStatistics(
      [
        {
          cadenceSeconds: 1,
          observations: [
            { timestamp: 0, value: 10 },
            { timestamp: 1, value: 11 },
            { timestamp: 5, value: 1000 },
            { timestamp: 6, value: 1001 },
            { timestamp: 7, value: 1002 }
          ]
        }
      ],
      { start: 0, end: 8 },
      { type: "counter", unit: "ops/s", totalUnit: "ops" }
    );
    assert.equal(r.statistics.total.observedTotal, 3);
    assert.equal(r.statistics.total.estimatedTotal, 1);
    assert.equal(r.coverage.missingSeconds, 4);
  });
  it("uses each source gap tolerance and requires two observed bins for percentiles", () => {
    const r = measurementStatistics(
      [
        {
          cadenceSeconds: 1,
          observations: observations([
            [0, 0],
            [1, 1],
            [5, 5]
          ])
        },
        {
          cadenceSeconds: 5,
          observations: observations([
            [0, 0],
            [5, 5]
          ])
        }
      ],
      { start: 0, end: 10 },
      { type: "counter", unit: "ops/s", totalUnit: "ops" }
    );
    assert.equal(r.coverage.observedSeconds, 1);
    assert.equal(r.statistics.p95.value, null);
  });
  it("never fills an absent member with zero", () => {
    const r = measurementStatistics(
      [
        {
          cadenceSeconds: 1,
          observations: observations([
            [0, 0],
            [1, 1],
            [2, 2]
          ])
        },
        { cadenceSeconds: 1, observations: [] }
      ],
      { start: 0, end: 3 },
      { type: "counter", unit: "ops/s", totalUnit: "ops" }
    );
    assert.equal(r.statistics.average.value, null);
    assert.equal(r.statistics.total.value, 3);
    assert.equal(r.statistics.total.status, "partial");
  });
  it("uses actual immutable measurement boundaries, with no run-window fallback", () => {
    assert.equal(
      resolveMeasurementWindow({
        startedAt: "2026-09-30T00:00:00Z",
        finishedAt: "2026-09-30T00:00:30Z"
      } as any).state,
      "not_started"
    );
    assert.throws(
      () =>
        resolveMeasurementWindow({
          measuringAt: "2026-09-30T00:00:10Z",
          finishedAt: "2026-09-30T00:00:30Z"
        } as any),
      /measurement_boundaries_missing/
    );
    const r = resolveMeasurementWindow({
      phaseBoundaries: {
        measurement: { startedAt: "2026-09-30T00:00:10Z", finishedAt: "2026-09-30T00:00:20Z" }
      },
      state: "INTERRUPTED",
      finishedAt: "2026-09-30T00:00:30Z"
    } as any);
    assert.equal(r.durationSeconds, 10);
    assert.equal(r.state, "interrupted");
  });
});

it("requires only contemporaneously active members and preserves periods with no active resource as gaps", () => {
  const result = measurementStatistics(
    [
      {
        cadenceSeconds: 1,
        activeIntervals: [{ start: 0, end: 3 }],
        observations: [0, 1, 2, 3].map((timestamp) => ({
          timestamp,
          value: timestamp,
          epoch: "old"
        }))
      },
      {
        cadenceSeconds: 1,
        activeIntervals: [{ start: 3, end: 6 }],
        observations: [3, 4, 5, 6].map((timestamp) => ({
          timestamp,
          value: 2 * (timestamp - 3),
          epoch: "new"
        }))
      }
    ],
    { start: 0, end: 6 },
    {
      type: "counter",
      unit: "cpu_percent",
      scale: 100,
      totalUnit: "cpu_seconds",
      totalScale: 0.01,
      allowExactEnd: true
    }
  );
  assert.equal(result.statistics.average.value, 150);
  assert.equal(result.statistics.total?.value, 9);
  assert.equal(result.coverage.missingSeconds, 0);
  const absent = measurementStatistics(
    [
      {
        cadenceSeconds: 1,
        activeIntervals: [{ start: 1, end: 3 }],
        observations: [1, 2, 3].map((timestamp) => ({ timestamp, value: timestamp }))
      }
    ],
    { start: 0, end: 5 },
    { type: "counter", unit: "per_second", allowExactEnd: true }
  );
  assert.equal(absent.coverage.missingSeconds, 3);
  assert.equal(absent.statistics.average.value, 1);
});
