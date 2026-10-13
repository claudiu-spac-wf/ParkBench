import test from "node:test";
import assert from "node:assert/strict";
import { TableRankSelector } from "../../apps/control-plane/src/grafana/table-ranking";

test("table membership is metric-specific, bounded, name-stable on exact ties and never biases unequal scores", () => {
  const reads = new TableRankSelector();
  const writes = new TableRankSelector();
  for (let i = 99; i >= 0; i--) {
    const name = `table-${String(i).padStart(3, "0")}`;
    reads.add(name, i);
    writes.add(name, 100 - i);
  }
  assert.equal(reads.names().length, 10);
  assert.equal(writes.names().length, 10);
  assert.equal(reads.names()[0], "table-099");
  assert.equal(writes.names()[0], "table-000");
  const ties = new TableRankSelector(2);
  ties.add("z", 1.000000001);
  ties.add("a", 1);
  ties.add("b", 1);
  assert.deepEqual(ties.names(), ["z", "a"]);
  ties.add("other", 10000);
  ties.add("unknown", null);
  ties.add("zero", 0);
  assert.deepEqual(ties.names(), ["z", "a"]);
  const zeros = new TableRankSelector();
  zeros.add("zero", 0);
  zeros.add("unknown", null);
  assert.deepEqual(zeros.names(), ["zero"]);
});

import { rankedTableQuery, RankedQuery } from "../../apps/control-plane/src/grafana/table-ranking";
test("continuous table ranking uses the requested phase window and retains raw cadence", async () => {
  const queries: string[] = [];
  const upstream = async (path: string, params: URLSearchParams) => {
    queries.push(params.get("query") ?? params.get("match[]") ?? "");
    if (path === "label/table/values") return { data: ["Customer"] };
    if (path === "query")
      return { data: { result: [{ metric: { table: "Customer" }, value: [8, "10"] }] } };
    return {
      data: {
        result: [
          {
            metric: { table: "Customer" },
            values: [
              [2, "1"],
              [3, "2"],
              [5, "4"],
              [6, "5"]
            ]
          }
        ]
      }
    };
  };
  const rows = await rankedTableQuery(
    {
      runId: "continuous",
      operation: "read",
      phase: "measurement",
      start: 1000,
      end: 8000,
      chartStart: 1000,
      chartEnd: 8000,
      stepSeconds: 1,
      view: "rate",
      instant: false,
      timeline: {
        runId: "continuous",
        continuousMetrics: true,
        phases: [
          { phase: "warmup", start: 1000, end: 3000 },
          { phase: "measurement", start: 3000, end: 6000 },
          { phase: "cooldown", start: 6000, end: 8000 }
        ]
      }
    },
    upstream
  );
  assert.ok(queries.every((query) => query.includes('phase=~"(measurement)|^$"')));
  assert.ok(queries.some((query) => query.includes("[3000ms] @ 6")));
  assert.deepEqual(rows[0].values, [
    [3, "2"],
    [5, "4"]
  ]);
});
test("diagnostic membership stays fixed across changing chart chunks and isolates operation, phase, window and run", async () => {
  let scoreCalls = 0,
    reverse = false;
  const queries: string[] = [];
  const upstream = async (path: string, params: URLSearchParams) => {
    const query = params.get("query") ?? "";
    queries.push(query);
    if (path === "label/table/values")
      return {
        data: [
          ...Array.from({ length: 100 }, (_, i) => `T${String(i).padStart(3, "0")}`),
          "other",
          "unknown",
          "zero"
        ]
      };
    if (query.includes("increase(")) {
      scoreCalls++;
      const reads = query.includes('operation="read"');
      return {
        data: {
          result: [
            ...Array.from({ length: 100 }, (_, i) => ({
              metric: { table: `T${String(i).padStart(3, "0")}` },
              value: [120, String(reads !== reverse ? i + 1 : 100 - i)]
            })),
            { metric: { table: "unknown" }, value: [120, "NaN"] },
            { metric: { table: "zero" }, value: [120, "0"] },
            { metric: { table: "other" }, value: [120, "10000"] }
          ]
        }
      };
    }
    if (query.startsWith("sum("))
      return {
        data: {
          result: [
            {
              metric: {},
              values: [
                [10, "4095"],
                [20, "5000"]
              ]
            }
          ]
        }
      };
    const pattern = JSON.parse('"' + query.match(/table=~"((?:\\.|[^"\\])*)"/)![1] + '"');
    return {
      data: {
        result: pattern.split("|").map((table: string) => ({
          metric: { table },
          values: [
            [10, "1"],
            [20, "9"]
          ]
        }))
      }
    };
  };
  const input: RankedQuery = {
    runId: "run-a",
    operation: "read",
    phase: "measurement",
    start: 0,
    end: 120000,
    chartStart: 0,
    chartEnd: 60000,
    stepSeconds: 5,
    view: "rate",
    instant: false
  };
  const first = await rankedTableQuery(input, upstream);
  assert.equal(first.filter((s) => !s.metric.display_remainder).length, 10);
  assert.ok(first.some((s) => s.metric.table === "T099"));
  assert.equal(first.filter((s) => s.metric.display_remainder).length, 1);
  reverse = true;
  const second = await rankedTableQuery(
    { ...input, chartStart: 60000, chartEnd: 120000 },
    upstream
  );
  assert.deepEqual(
    second.map((s) => s.metric.table),
    first.map((s) => s.metric.table)
  );
  assert.equal(scoreCalls, 1);
  for (const changed of [
    { operation: "write" },
    { phase: "warmup" },
    { runId: "run-b" },
    { start: 1000 }
  ])
    await rankedTableQuery({ ...input, ...changed }, upstream);
  assert.equal(scoreCalls, 5);
  assert.ok(queries.filter((q) => q.includes("increase(")).every((q) => q.includes("@ 120")));
  const writer = queries.find((q) => q.includes('operation=~"create|update|delete"'));
  assert.ok(writer);
  assert.equal(writer.includes("os_read"), false);
  const isolated = async (path: string, params: URLSearchParams) => upstream(path, params);
  await rankedTableQuery(input, isolated);
  assert.equal(scoreCalls, 6);
});

test("chart means use finite observations and tie identities remain stable after upstream reorder", async () => {
  const { orderRankedSeries } = await import("../../apps/control-plane/src/grafana/table-ranking");
  const rows = [
    {
      metric: { run_id: "same", pool: "primary" },
      values: [
        [1, "5"],
        [2, "NaN"]
      ]
    },
    {
      metric: { run_id: "same", pool: "alternate" },
      values: [
        [1, "5"],
        [2, "5"]
      ]
    },
    {
      metric: { run_id: "missing" },
      values: [
        [1, "NaN"],
        [2, "+Inf"]
      ]
    },
    {
      metric: { run_id: "high" },
      values: [
        [1, "10"],
        [2, "14"]
      ]
    }
  ];
  const before = structuredClone(rows);
  const sorted = orderRankedSeries(rows, "rate");
  assert.deepEqual(
    sorted.map((r) => r.metric.pool ?? r.metric.run_id),
    ["high", "alternate", "primary", "missing"]
  );
  assert.deepEqual(orderRankedSeries([...rows].reverse(), "rate"), sorted);
  assert.deepEqual(rows, before);
});
