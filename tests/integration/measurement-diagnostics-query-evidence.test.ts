import test from "node:test";
import assert from "node:assert/strict";
import { HttpPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import {
  withQueryEvidence,
  validateDiagnosticSelector
} from "../../packages/metrics/src/query-evidence";
const context = (records: any[], selectors: any[]) => ({
  runId: "run-1",
  runIds: ["run-1"],
  diagnosticAttemptId: "a1",
  consumer: "FINALIZATION" as const,
  source: "parkbench-runs",
  definitionId: "db.table.read",
  semanticVersion: "measurement-summary.v1",
  dimensions: { table: "Account" },
  expectedMemberIds: ["database"],
  expectationRefs: ["expectation-1"],
  requestedStartMs: 1000,
  requestedEndMs: 11000,
  nativeCadenceMs: 5000,
  scrapeCadenceMs: 1000,
  lookbackMs: null,
  transforms: [],
  counterEdgePolicy: "counter-window.v1",
  record: (e: any) => records.push(e),
  registerSelector: (e: any) => {
    selectors.push(e);
    return `selector-${selectors.length}`;
  }
});
test("raw stored sample queries retain bounded metadata and exact validated selectors, not response bodies", async () => {
  const fetch = globalThis.fetch,
    records: any[] = [],
    selectors: any[] = [];
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: {
                __name__: "public_counter_total",
                run_id: "run-1",
                service: "database",
                table: "Account"
              },
              values: [
                [1, "7"],
                [6, "7"]
              ]
            }
          ]
        }
      })
    )) as any;
  try {
    const samples = await withQueryEvidence(context(records, selectors), () =>
      new HttpPrometheusClient("http://fixture").queryRawRange(
        'public_counter_total{run_id="run-1",table="Account"}',
        1,
        11,
        5,
        { priority: "finalization" }
      )
    );
    assert.equal(samples.length, 2);
    assert.ok(samples.every((s) => s.value === 7));
    assert.equal(records.length, 1);
    const q = records[0];
    assert.equal(q.mode, "RAW_STORED_SAMPLES");
    assert.equal(q.sampleCount, 2);
    assert.equal(q.sourceTimestampMinMs, 1000);
    assert.equal(q.sourceTimestampMaxMs, 6000);
    assert.equal(q.requestedStartMs, 1000);
    assert.equal(q.effectiveEndMs, 11000);
    assert.equal(q.nativeCadenceMs, 5000);
    assert.equal(q.scrapeCadenceMs, 1000);
    assert.equal(q.stepMs, null);
    assert.equal(q.memberCount, 1);
    assert.deepEqual(q.missingMemberIds, []);
    assert.ok(q.responseBytes > 0 && q.durationMs >= 0 && q.queueWaitMs >= 0 && q.bodyReadMs >= 0);
    assert.ok(!JSON.stringify(records).includes('"values"'));
    assert.ok(!JSON.stringify(records).includes('"samples"'));
    assert.equal(selectors[0].metricName, "public_counter_total");
    assert.equal(selectors[0].matchers.find((m: any) => m.name === "run_id").value, "run-1");
  } finally {
    globalThis.fetch = fetch;
  }
});
test("evaluation grids are explicitly different and missing members remain visible", async () => {
  const fetch = globalThis.fetch,
    records: any[] = [],
    selectors: any[] = [];
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: { __name__: "public_counter_total", run_id: "run-1", service: "database" },
              values: [
                [1, "0"],
                [2, "0"],
                [3, "0"]
              ]
            }
          ]
        }
      })
    )) as any;
  try {
    await withQueryEvidence(
      {
        ...context(records, selectors),
        consumer: "GRAFANA",
        expectedMemberIds: ["database", "pas-1"]
      },
      () =>
        new HttpPrometheusClient("http://fixture").queryRange(
          'public_counter_total{run_id="run-1"}',
          1,
          3,
          1
        )
    );
    const q = records[0];
    assert.equal(q.mode, "EVALUATION_GRID");
    assert.equal(q.stepMs, 1000);
    assert.equal(q.sampleCount, 3);
    assert.equal(q.sourceTimestampMinMs, null);
    assert.equal(q.sourceTimestampMaxMs, null);
    assert.deepEqual(q.missingMemberIds, ["pas-1"]);
    assert.ok(q.reasonCodes.includes("evaluation_points_are_not_acquisitions"));
  } finally {
    globalThis.fetch = fetch;
  }
});
test("unvalidated/cross-run/arbitrary selectors are never recorded as reproducible source references", () => {
  assert.equal(
    validateDiagnosticSelector('public_counter_total{run_id="other"}', ["run-1"], "parkbench-runs"),
    undefined
  );
  assert.equal(
    validateDiagnosticSelector(
      'public_counter_total{password="private"}',
      ["run-1"],
      "parkbench-runs"
    ),
    undefined
  );
  assert.equal(
    validateDiagnosticSelector("sum(rate(public_counter_total[5m]))", ["run-1"], "parkbench-runs"),
    undefined
  );
  assert.ok(
    validateDiagnosticSelector(
      'container_cpu_usage_seconds_total{job="cadvisor"}',
      ["run-1"],
      "cadvisor"
    )
  );
});
test("query failures and callback failures preserve existing measurement behavior", async () => {
  const fetch = globalThis.fetch,
    records: any[] = [],
    selectors: any[] = [];
  globalThis.fetch = (async () => {
    throw new Error("credential=private");
  }) as any;
  try {
    await assert.rejects(() =>
      withQueryEvidence(context(records, selectors), () =>
        new HttpPrometheusClient("http://fixture").queryRawRange(
          'public_counter_total{run_id="run-1"}',
          1,
          11,
          5
        )
      )
    );
    assert.equal(records[0].outcome, "FAILED");
    assert.ok(!JSON.stringify(records).includes("private"));
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } })
      )) as any;
    const result = await withQueryEvidence(
      {
        ...context([], []),
        record: () => {
          throw new Error("ENOSPC");
        }
      },
      () =>
        new HttpPrometheusClient("http://fixture").queryRawRange(
          'public_counter_total{run_id="run-1"}',
          1,
          11,
          5
        )
    );
    assert.deepEqual(result, []);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("projection metadata preserves per-scope/statistic reasons and real zeros without retaining values", async () => {
  const { calculateSummaryRow } = await import("../../packages/metrics/src/measurement-summary");
  const { RESOURCE_SUMMARY_CATALOG } = await import("../../packages/contracts/src/summary-catalog");
  const projections: any[] = [],
    decisions: any[] = [];
  const definition = RESOURCE_SUMMARY_CATALOG.find(
    (d) => d.group === "platform" && d.definitionId === "disk.read.bytes"
  )!;
  const scope: any = {
    ...context([], []),
    recordProjection: (e: any) => projections.push(e),
    recordStatistics: (e: any) => decisions.push(e)
  };
  const row = withQueryEvidence(scope, () =>
    calculateSummaryRow(
      definition,
      { service: "control-plane" },
      [
        {
          physicalId: "cp-1",
          cadenceSeconds: 5,
          observations: [
            { timestamp: 0, value: 0 },
            { timestamp: 5, value: 0 },
            { timestamp: 10, value: 0 }
          ]
        },
        { physicalId: "missing-1", cadenceSeconds: 5, observations: [] }
      ],
      { start: 0, end: 15 }
    )
  );
  assert.equal(row.statistics.average.value, null);
  assert.equal(row.statistics.total?.value, 0);
  assert.equal(projections.length, 4);
  assert.ok(projections.every((p) => p.dimensions.service === "control-plane"));
  assert.ok(
    projections
      .find((p) => p.statistic === "average")
      .reasonCodes.includes("required_member_missing")
  );
  assert.ok(projections.find((p) => p.statistic === "total").status === "partial");
  assert.equal(decisions.length, 2);
  assert.equal(decisions.find((d) => d.physicalId === "cp-1").storedObservations, 3);
  assert.ok(!JSON.stringify(projections).includes('"value"'));
  assert.ok(!JSON.stringify(decisions).includes('"observedTotal"'));
});
test("statistics decision evidence records resets/conflicts/window/bin policy without changing its source oracle", async () => {
  const { measurementStatistics } =
    await import("../../packages/metrics/src/measurement-statistics");
  const decisions: any[] = [];
  const result = withQueryEvidence(
    { ...context([], []), recordStatistics: (e: any) => decisions.push(e) } as any,
    () =>
      measurementStatistics(
        [
          {
            physicalId: "db-1",
            cadenceSeconds: 5,
            observations: [
              { timestamp: 0, value: 10, epoch: "a" },
              { timestamp: 5, value: 12, epoch: "a" },
              { timestamp: 5, value: 13, epoch: "a" },
              { timestamp: 10, value: 0, epoch: "b" }
            ]
          }
        ],
        { start: 0, end: 15 },
        { type: "counter", unit: "ops_per_second", totalUnit: "ops" }
      )
  );
  assert.ok(result.coverage.reasons.includes("conflicting_observation"));
  assert.equal(decisions[0].counts.conflictingTimestamps, 1);
  assert.equal(decisions[0].counts.resetIntervals, 1);
  assert.equal(decisions[0].counts.epochTransitionIntervals, 1);
  assert.equal(decisions[0].startMs, 0);
  assert.equal(decisions[0].endMs, 15000);
  assert.ok(!JSON.stringify(decisions).includes('"observations"'));
});

test("finalization diagnostic drainage cannot change the summary result when its sink fails", async () => {
  const { flushQueryEvidence } = await import("../../packages/metrics/src/query-evidence");
  const losses: string[] = [];
  const result = await withQueryEvidence(
    {
      ...context([], []),
      flush: async () => {
        throw new Error("ENOSPC");
      },
      reportLoss: (reason) => losses.push(reason)
    },
    async () => {
      await flushQueryEvidence();
      return 42;
    }
  );
  assert.equal(result, 42);
  assert.deepEqual(losses, ["query_evidence_flush_failed"]);
});
