import assert from "node:assert/strict";
import { it } from "node:test";
import {
  COMPARISON_METRIC_CATALOG,
  DEFAULT_COMPARISON_METRICS,
  validateMetricSelectionRequest,
  selectionIdentity,
  validateMetricSelectionResponse
} from "../../packages/contracts/src/comparison-metric-selection";
const request = () => ({
  contractVersion: "comparison-metric-selection.v1",
  selectionRevision: 1,
  runIds: ["r"],
  metrics: [{ metricId: "resource.database.memory.used", statistics: ["average"], selectors: {} }]
});
it("provides distinct browser safe group identities, existing defaults and native/workload adapters", () => {
  assert.equal(
    new Set(COMPARISON_METRIC_CATALOG.map((d) => d.metricId)).size,
    COMPARISON_METRIC_CATALOG.length
  );
  assert.ok(COMPARISON_METRIC_CATALOG.some((d) => d.metricId === "resource.pas.cpu.usage"));
  assert.ok(COMPARISON_METRIC_CATALOG.some((d) => d.domain === "native_latch"));
  assert.ok(COMPARISON_METRIC_CATALOG.some((d) => d.metricId === "workload.latency.p50"));
  assert.ok(DEFAULT_COMPARISON_METRICS.length > 10);
  for (const d of COMPARISON_METRIC_CATALOG) assert.ok(d.version && d.statistics.length && d.units);
});
it("rejects unsupported statistics, forbidden/unknown selectors, duplicate choices, wrong versions and bounds", () => {
  validateMetricSelectionRequest(request());
  for (const mutate of [
    (r: any) => (r.metrics[0].statistics = ["total"]),
    (r: any) => (r.metrics[0].selectors = { run_id: "r" }),
    (r: any) => r.metrics.push(r.metrics[0]),
    (r: any) => (r.metrics[0].metricId = "unknown"),
    (r: any) => (r.runIds = Array.from({ length: 26 }, (_, i) => String(i))),
    (r: any) => (r.limit = 501),
    (r: any) => (r.selectionRevision = 0),
    (r: any) => (r.contractVersion = "comparison.v2"),
    (r: any) => (r.metrics[0].statistics = ["average", "average"])
  ]) {
    const r = request();
    mutate(r);
    assert.throws(() => validateMetricSelectionRequest(r));
  }
});
it("canonicalizes semantic selection identities without allowing run/time/epoch selectors", () => {
  assert.equal(
    selectionIdentity([
      {
        metricId: "database.db.buffer.logical.read",
        statistics: ["total", "average"],
        selectors: { pool: "primary" }
      }
    ]),
    selectionIdentity([
      {
        metricId: "database.db.buffer.logical.read",
        statistics: ["average", "total"],
        selectors: { pool: "primary" }
      }
    ])
  );
  const r = request();
  r.metrics = [];
  validateMetricSelectionRequest(r);
});

it("validates explicit null availability and rejects fabricated or nonfinite response values", async () => {
  const row: any = {
    rowId: "row",
    runId: "r",
    runState: "FAILED",
    measurementValidity: "INCOMPLETE",
    metricId: "resource.database.memory.used",
    descriptorVersion: 1,
    statistic: "average",
    unit: "bytes",
    dimensions: {},
    value: null,
    availability: "unavailable",
    reasons: ["not_collected"],
    sourceReferences: [],
    sourceIdentity: "published",
    warnings: [],
    difference: {
      value: null,
      baseline: null,
      absoluteDifference: null,
      percentageDifference: null
    }
  };
  const response: any = {
    contractVersion: "comparison-metric-selection.v1",
    comparisonId: "c",
    selectionRevision: 1,
    selectionIdentity: "[]",
    sourceIdentity: "source",
    rows: [row],
    returnedRowCount: 1,
    hasMore: false
  };
  validateMetricSelectionResponse(response);
  for (const change of [
    { value: Infinity },
    { value: 0 },
    { availability: "available" },
    { unit: "seconds" },
    { statistic: "total" },
    { descriptorVersion: 2 },
    {
      difference: {
        value: null,
        baseline: 1,
        absoluteDifference: Infinity,
        percentageDifference: null
      }
    }
  ])
    assert.throws(() =>
      validateMetricSelectionResponse({ ...response, rows: [{ ...row, ...change }] })
    );
});
