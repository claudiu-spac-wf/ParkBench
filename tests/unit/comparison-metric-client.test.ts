import assert from "node:assert/strict";
import { it } from "node:test";
import { MetricValuesLoader } from "../../apps/web/src/features/comparison/comparisonApi";
import {
  supportedMetricSelection,
  removeUnavailableMetricSelection,
  changeMetricStatistic
} from "../../apps/web/src/features/comparison/metricSelection";

it("statistic edits preserve exact selector identity, valid arrays, and stale siblings", () => {
  const first = {
    metricId: "database.db.table.read",
    statistics: ["average", "p95"] as any,
    selectors: { table: "Customer" }
  };
  const second = { ...first, selectors: { table: "Order" } };
  const stale = { metricId: "future.metric", statistics: ["value"] as any, selectors: {} };
  const selection = [first, second, stale];
  const original = JSON.stringify(selection);
  const reduced = changeMetricStatistic(selection, 0, "p95", false);
  assert.deepEqual(reduced[0].statistics, ["average"]);
  assert.equal(reduced[1], second);
  assert.equal(reduced[2], stale);
  const removed = changeMetricStatistic(reduced, 0, "average", false);
  assert.deepEqual(removed, [second, stale]);
  const restored = changeMetricStatistic(reduced, 0, "p95", true);
  assert.deepEqual(restored[0].statistics, ["average", "p95"]);
  assert.equal(changeMetricStatistic(restored, 0, "p95", true), restored);
  assert.equal(changeMetricStatistic(selection, 0, "value", true), selection);
  assert.equal(changeMetricStatistic(selection, 2, "total", true), selection);
  assert.equal(changeMetricStatistic(selection, -1, "average", true), selection);
  assert.equal(JSON.stringify(selection), original);
});
it("removing a stale choice preserves overlapping ids and other statistics/selectors of the same id", () => {
  const selection: any = [
    { metricId: "resource.platform.cpu.usage", statistics: ["average"], selectors: {} },
    { metricId: "resource.platform.cpu.usage.future", statistics: ["value"], selectors: {} },
    { metricId: "resource.platform.cpu.usage", statistics: ["value"], selectors: {} },
    {
      metricId: "database.db.table.read",
      statistics: ["average"],
      selectors: { table: "Customer" }
    },
    { metricId: "database.db.table.read", statistics: ["value"], selectors: { table: "Order" } }
  ];
  const original = JSON.stringify(selection);
  const unavailable = supportedMetricSelection(selection).unavailable;
  assert.deepEqual(
    unavailable.map((u) => u.index),
    [1, 2, 4]
  );
  let next = removeUnavailableMetricSelection(selection, unavailable[0].index);
  assert.equal(next.length, 4);
  assert.deepEqual(next[0], selection[0]);
  next = removeUnavailableMetricSelection(
    next,
    supportedMetricSelection(next).unavailable[0].index
  );
  next = removeUnavailableMetricSelection(
    next,
    supportedMetricSelection(next).unavailable[0].index
  );
  assert.deepEqual(next, [selection[0], selection[3]]);
  assert.equal(JSON.stringify(selection), original);
});
import {
  selectionIdentity,
  type MetricSelectionRequest,
  type MetricSelectionResponse
} from "../../packages/contracts/src/comparison-metric-selection";
function result(
  request: MetricSelectionRequest,
  rows: any[] = [],
  changes: any = {}
): MetricSelectionResponse {
  return {
    contractVersion: "comparison-metric-selection.v1",
    comparisonId: "c",
    selectionRevision: 1,
    selectionIdentity: selectionIdentity(request.metrics),
    sourceIdentity: "stable",
    rows,
    returnedRowCount: rows.length,
    hasMore: false,
    ...changes
  };
}
it("traverses all eight definition batches in a 256 entry preset and explicit additional pages", async () => {
  const calls: MetricSelectionRequest[] = [];
  const loader = new MetricValuesLoader(async (_id, r) => {
    calls.push(r);
    return result(r, [], { hasMore: !r.cursor, nextCursor: !r.cursor ? "next" : undefined });
  });
  const metrics = Array.from({ length: 256 }, (_, i) => ({
    metricId: "database.db.table.read",
    statistics: ["average"] as any,
    selectors: { table: String(i) }
  }));
  const first = await loader.load("c", 1, ["v"], metrics);
  assert.equal(calls.length, 8);
  assert.ok(first?.hasMore);
  assert.equal((await loader.next())?.hasMore, false);
  assert.equal(calls.length, 16);
  assert.equal(
    new Set(calls.slice(0, 8).flatMap((r) => r.metrics.map((m) => m.selectors.table))).size,
    256
  );
});
it("rejects changed summary identities and suppresses an obsolete selection response", async () => {
  let release!: (value: any) => void;
  let first: MetricSelectionRequest | undefined;
  let calls = 0;
  const loader = new MetricValuesLoader(async (_id, r) => {
    calls++;
    if (calls === 1) {
      first = r;
      return new Promise((resolve) => (release = resolve));
    }
    return result(r);
  });
  const m = [{ metricId: "workload.completed", statistics: ["total"] as any, selectors: {} }];
  const old = loader.load("c", 1, ["v"], m),
    current = await loader.load("c", 1, ["v"], []);
  release(result(first!));
  assert.equal(await old, undefined);
  assert.deepEqual(current?.rows, []);
  let n = 0;
  const changed = new MetricValuesLoader(async (_id, r) =>
    result(r, [], { sourceIdentity: ++n === 1 ? "old" : "new", hasMore: true, nextCursor: "next" })
  );
  await changed.load("c", 1, ["v"], m);
  await assert.rejects(changed.next(), /changed/);
});
