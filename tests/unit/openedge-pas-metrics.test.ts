import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatOpenEdgePasMetrics } from "../../packages/observers/src/openedge-pas/metrics";
import { CORE_METRICS } from "../../packages/contracts/src/metrics";

describe("OpenEdge PAS WEB transport metrics", () => {
  it("exports per-replica request, error, and latency measurements with correct types and units", () => {
    const text = formatOpenEdgePasMetrics(
      {
        servletRequests: 12,
        postRequests: 10,
        failedServletRequests: 2,
        postErrors: 2,
        avgABLProcessingTime: 250,
        unrelatedMetric: 50
      },
      2
    );
    assert.match(text, /# TYPE parkbench_openedge_pas_requests_total counter/);
    assert.match(
      text,
      /parkbench_openedge_pas_requests_total\{source="pas-management",replica="pas-2"\} 12/
    );
    assert.match(text, /parkbench_openedge_pas_failed_requests_total\{[^}]*replica="pas-2"\} 2/);
    assert.match(
      text,
      /parkbench_openedge_pas_avg_abl_processing_seconds\{[^}]*replica="pas-2"\} 0\.25/
    );
    assert.doesNotMatch(text, /unrelatedMetric/);
    for (const name of [
      "parkbench_openedge_pas_requests_total",
      "parkbench_openedge_pas_failed_requests_total",
      "parkbench_openedge_pas_avg_abl_processing_seconds"
    ])
      assert.ok(CORE_METRICS.includes(name as (typeof CORE_METRICS)[number]));
  });
});

import { OpenEdgePasObserver } from "../../packages/observers/src/openedge-pas/adapter";
import { selectPasReplicaTargets } from "../../packages/observers/src/openedge-pas/metrics";
describe("PAS adapter identity and parser preservation", () => {
  it("uses the shared catalog and converts milliseconds exactly once", async () => {
    const o = new OpenEdgePasObserver(
      async () => ({ servletRequests: 12, avgABLProcessingTime: 250 }),
      [2, 5]
    );
    const s = await o.sample({
      runId: "r",
      experimentId: "e",
      variantId: "v",
      repetition: 1,
      phase: "measurement"
    });
    assert.deepEqual([...new Set(s.map((x) => x.labels.replica))], ["pas-2", "pas-5"]);
    assert.equal(s.find((x) => x.metricName.endsWith("requests_total")).type, "counter");
    assert.equal(s.find((x) => x.metricName.endsWith("avg_abl_processing_seconds")).value, 0.25);
  });
  it("retains parsed labels, counter type and capture timestamp without scaling normalized seconds", async () => {
    const o = new OpenEdgePasObserver(
      async () =>
        [
          {
            metricName: "parkbench_openedge_pas_requests_total",
            type: "counter",
            value: 12,
            timestamp: 100,
            labels: { operation: "post", replica: "2" },
            source: "native"
          },
          {
            metricName: "parkbench_openedge_pas_avg_abl_processing_seconds",
            type: "gauge",
            value: 0.25,
            timestamp: 100,
            labels: { replica: "2" },
            source: "native"
          }
        ] as any,
      2
    );
    const s = await o.sample({
      runId: "r",
      experimentId: "e",
      variantId: "v",
      repetition: 1,
      phase: "measurement"
    });
    assert.equal(s[0].labels.operation, "post");
    assert.equal(s[0].labels.replica, "pas-2");
    assert.equal(s[0].timestamp, 100);
    assert.equal(s[1].value, 0.25);
  });
  it("selects original indices even when endpoint URLs coincide", () => {
    assert.deepEqual(selectPasReplicaTargets(["same", "same", "other"], 2), [
      { target: "same", replica: 2 }
    ]);
    assert.deepEqual(selectPasReplicaTargets(["a", "b", "c"]), [
      { target: "a", replica: 1 },
      { target: "b", replica: 2 },
      { target: "c", replica: 3 }
    ]);
    assert.throws(() => selectPasReplicaTargets(["a"], 2));
  });
});
