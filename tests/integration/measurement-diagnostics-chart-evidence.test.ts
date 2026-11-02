import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerGrafanaRoutes } from "../../apps/control-plane/src/grafana";
import {
  captureChartEvidence,
  boundedChartHeader,
  recordChartDecision
} from "../../apps/control-plane/src/measurement-diagnostics/chart-evidence";
import { counterWindow } from "../../apps/control-plane/src/grafana/native-counter-window";
const start = Date.UTC(2026, 9, 30, 12);
test("actual datasource response exposes exact clock query metadata while retaining its result contract", async (t) => {
  const timeline = {
    runId: "run-1",
    startedAt: start,
    endedAt: start + 30000,
    measurementStart: start,
    continuousMetrics: true,
    phases: [{ phase: "measurement" as const, start, end: start + 30000 }]
  };
  const app = Fastify();
  t.after(() => app.close());
  const before = structuredClone(timeline);
  registerGrafanaRoutes(app, {
    prometheusUrl: "http://fixture",
    grafanaUrl: "http://grafana",
    timelines: { get: (id) => (id === "run-1" ? timeline : undefined), list: () => [timeline] },
    log: () => {},
    fetch: (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: { run_id: "run-1" },
                values: [
                  [start / 1000, "0"],
                  [start / 1000 + 5, "NaN"]
                ]
              }
            ]
          }
        })
      )) as any
  });
  const response = await app.inject({
    url:
      "/api/v1/grafana/prom/api/v1/query_range?" +
      new URLSearchParams({
        query: 'public_metric{run_id="run-1",phase="measurement"}',
        start: String(start / 1000),
        end: String(start / 1000 + 30),
        step: "5"
      })
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.result[0].values[0][1], "0");
  const evidence = JSON.parse(
    Buffer.from(response.headers["x-parkbench-query-evidence"] as string, "base64url").toString()
  );
  assert.equal(evidence.contractVersion, "measurement-chart-query.v1");
  assert.equal(evidence.requestedStartMs, start);
  assert.equal(evidence.requestedEndMs, start + 30000);
  assert.equal(evidence.stepMs, 5000);
  assert.equal(evidence.queryMode, "EVALUATION_GRID");
  assert.equal(evidence.evaluationPointCount, 2);
  assert.ok(evidence.decisions.some((d: any) => d.stage === "ALIGNMENT" && d.shiftMs === 0));
  assert.ok(
    evidence.decisions.some((d: any) => d.stage === "UPSTREAM" && d.counts.responseBytes > 0)
  );
  assert.ok(!JSON.stringify(evidence).includes('"values"'));
  assert.deepEqual(timeline, before);
});
test("native counter decisions retain honest missing-window reasons and bounded aggregates, not metric values", async () => {
  const captured = await captureChartEvidence(async () => {
    assert.equal(
      counterWindow(
        [
          [0, 0],
          [5, 0]
        ],
        0,
        5,
        5
      ),
      null
    );
    return counterWindow(
      [
        [0, 0],
        [5, 0],
        [10, 0]
      ],
      0,
      10,
      5
    );
  });
  assert.equal(captured.result?.increase, 0);
  assert.ok(
    captured.decisions.some((d) =>
      d.reasonCodes.includes("native_counter_observations_insufficient")
    )
  );
  assert.ok(captured.decisions.some((d) => d.reasonCodes.includes("counter_left_open_window")));
  assert.ok(!JSON.stringify(captured.decisions).includes('"increase"'));
  const large = await captureChartEvidence(async () => {
    for (let n = 0; n < 100; n++)
      recordChartDecision({
        stage: "ALIGNMENT",
        outcome: "SUCCEEDED",
        runId: `run-${n}`,
        reasonCodes: ["clock_axis"]
      });
  });
  assert.equal(large.incomplete, true);
  assert.ok(large.decisions.length <= 8);
  const encoded = boundedChartHeader({
    contractVersion: "measurement-chart-query.v1",
    queryId: "q",
    runIds: Array.from({ length: 128 }, () => "x".repeat(128)),
    mode: "clock",
    queryMode: "EVALUATION_GRID",
    requestedStartMs: 0,
    requestedEndMs: 1,
    stepMs: 1,
    durationMs: 0,
    seriesCount: 0,
    evaluationPointCount: 0,
    decisions: large.decisions,
    incomplete: large.incomplete,
    droppedDecisionKinds: large.droppedDecisionKinds
  });
  assert.ok(Buffer.from(encoded, "base64url").length <= 4096);
  assert.equal(JSON.parse(Buffer.from(encoded, "base64url").toString()).incomplete, true);
});
