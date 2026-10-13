import assert from "node:assert/strict";
import { it } from "node:test";
import golden from "../fixtures/benchmark-readiness/native-series.json";
import type { NativeMatrix } from "../../apps/control-plane/src/grafana/native-diagnostics";
import {
  canonicalNativeSeries,
  freeCapacity,
  cumulativeHitRatio,
  phaseOwner
} from "../../apps/control-plane/src/grafana/native-diagnostics";
const timeline = {
  runId: golden.timeline.runId,
  startedAt: golden.timeline.startedAt,
  endedAt: golden.timeline.endedAt,
  phases: Object.entries(golden.timeline.phases).map(([phase, [start, end]]) => ({
    phase,
    start: start * 1000,
    end: end * 1000
  })),
  nativePublisher: "endpoint"
} as any;
const name = "parkbench_openedge_db_buffer_pool_active_buffers";
const metric = {
  __name__: name,
  run_id: timeline.runId,
  pool: "primary",
  job: "parkbench-runs",
  instance: "one"
};
it("owns legacy samples by half-open recorded phases before merging transport copies", () => {
  const source: NativeMatrix[] = golden.historical.map((row) => ({
    metric: { ...metric, phase: row.phase },
    values: [[row.timestamp, String(row.active)]]
  }));
  const before = JSON.stringify(source);
  const result = canonicalNativeSeries(source, [timeline]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].values, [[1800000020, 10]]);
  assert.equal(result[0].metric.phase, undefined);
  assert.equal(result[0].metric.instance, undefined);
  assert.equal(phaseOwner(timeline, 1800000040), "measurement");
  assert.equal(JSON.stringify(source), before);
  assert.equal(phaseOwner(timeline, 1800000005), "idle");
  assert.equal(phaseOwner({ ...timeline, startedAt: undefined }, 1800000005), undefined);
});
it("coalesces exact duplicates, diagnoses conflicts, and selects the recorded publisher", () => {
  const source: NativeMatrix[] = [
    { metric: { ...metric, phase: "warmup" }, values: [[1800000020, "10"]] }
  ];
  assert.deepEqual(canonicalNativeSeries([...source, ...source], [timeline])[0].values, [
    [1800000020, 10]
  ]);
  const conflict: NativeMatrix = {
    metric: { ...metric, instance: "two", phase: "warmup" },
    values: [[1800000020, "11"]]
  };
  assert.deepEqual(canonicalNativeSeries([...source, conflict], [timeline])[0].values, [
    [1800000020, null]
  ]);
  assert.deepEqual(
    canonicalNativeSeries(
      [
        ...source,
        {
          metric: { ...metric, job: "parkbench-control-plane", phase: "warmup" },
          values: [[1800000020, "99"]]
        }
      ],
      [timeline]
    )[0].values,
    [[1800000020, 10]]
  );
  assert.equal(canonicalNativeSeries(source, []).length, 0);
});
it("preserves genuine run, pool, and epoch identities and continuous observations", () => {
  const timelines = golden.identities.map((identity) => ({
    ...timeline,
    runId: identity.runId,
    continuousMetrics: true
  }));
  const source: NativeMatrix[] = golden.identities.map((identity) => ({
    metric: {
      ...metric,
      run_id: identity.runId,
      pool: identity.pool,
      database_epoch: identity.database_epoch
    },
    values: [[1800000040, "20"]]
  }));
  assert.equal(canonicalNativeSeries(source, timelines).length, 4);
  assert.equal(
    canonicalNativeSeries(
      [{ metric: { ...metric, phase: "warmup" }, values: [[1800000040, "10"]] }],
      [timeline]
    ).length,
    0
  );
  assert.equal(
    canonicalNativeSeries(
      [{ metric, values: [[1800000040, "20"]] }],
      [{ ...timeline, continuousMetrics: true }]
    ).length,
    1
  );
});
it("derives known free capacity and lifetime ratio while preserving zero and near-one values", () => {
  assert.equal(freeCapacity(100, 10), golden.expected.free);
  assert.equal(cumulativeHitRatio(1000, 100), golden.expected.hitRatio);
  for (const [capacity, active] of [
    [undefined, 10],
    [100, 101],
    [100, -1],
    [0, 0]
  ])
    assert.equal(freeCapacity(capacity, active), null);
  assert.equal(freeCapacity(100, 100), 0);
  assert.equal(cumulativeHitRatio(1000, 1000), 0);
  assert.equal(cumulativeHitRatio(1e9, 1), 0.999999999);
  for (const [logical, os] of [
    [0, 0],
    [100, 101],
    [undefined, 0],
    [100, -1]
  ])
    assert.equal(cumulativeHitRatio(logical, os), null);
});

it("phase windows include only evidenced idle startup/drain and do not manufacture empty totals", async () => {
  const { nativePhaseWindows } =
    await import("../../apps/control-plane/src/grafana/native-diagnostics");
  const timeline = {
    runId: "idle-test",
    startedAt: 1000,
    endedAt: 21000,
    phases: [
      { phase: "warmup" as const, start: 4000, end: 9000 },
      { phase: "measurement" as const, start: 9000, end: 15000 },
      { phase: "cooldown" as const, start: 15000, end: 18000 }
    ]
  };
  assert.deepEqual(nativePhaseWindows(timeline, 0, 30000, "idle", 30000), [
    { start: 1, end: 4 },
    { start: 18, end: 21 }
  ]);
  assert.deepEqual(nativePhaseWindows(timeline, 0, 30000, "measurement", 30000), [
    { start: 9, end: 15 }
  ]);
  assert.deepEqual(nativePhaseWindows(timeline, 22000, 30000, ".*", 30000), []);
});
