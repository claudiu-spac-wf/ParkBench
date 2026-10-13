import test from "node:test";
import assert from "node:assert/strict";
import catalog from "../../packages/contracts/src/openedge-db-metric-catalog.json";
import {
  inferMetricType,
  PrometheusMetricBuffer
} from "../../packages/metrics/src/prometheus-client";
test("every native catalog type agrees with raw inference and arbitrary _count gauges keep their exact declaration", () => {
  for (const metric of catalog.entries)
    assert.equal(inferMetricType(`parkbench_openedge_db_${metric.name}`), metric.type, metric.name);
  assert.equal(inferMetricType("active_session_count"), "gauge");
  assert.equal(inferMetricType("parkbench_workload_request_duration_seconds_count"), "histogram");
  const buffer = new PrometheusMetricBuffer();
  buffer.append([
    {
      metricName: "active_session_count",
      type: "gauge",
      labels: {} as any,
      timestamp: 1,
      value: 2,
      source: "fixture"
    },
    {
      metricName: "fixture_hist_bucket",
      type: "histogram",
      labels: { le: "+Inf" } as any,
      timestamp: 1,
      value: 5,
      source: "fixture"
    }
  ]);
  assert.match(buffer.render(), /# TYPE active_session_count gauge/);
  assert.match(buffer.render(), /# TYPE fixture_hist histogram/);
  assert.doesNotMatch(buffer.render(), /# TYPE active_session gauge|# TYPE fixture_hist_bucket/);
});
