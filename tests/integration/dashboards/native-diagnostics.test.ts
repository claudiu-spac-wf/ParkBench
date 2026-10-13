import assert from "node:assert/strict";
import { it } from "node:test";
import {
  NATIVE_QUERY_LIMITS,
  nativeLimits,
  NativeQueryBudget,
  NativeMatrixCache
} from "../../../apps/control-plane/src/grafana/native-query-budget";
const payload = JSON.stringify({ status: "success", data: { result: [] } });
const upstream =
  (text = payload) =>
  async () =>
    new Response(text, { headers: { "content-type": "application/json" } });
it("enforces named defaults, whole-query aggregate byte/request budgets and streamed response boundaries", async () => {
  assert.deepEqual(NATIVE_QUERY_LIMITS, {
    windowMs: 2678400000,
    deadlineMs: 30000,
    concurrency: 4,
    requests: 64,
    responseBytes: 8388608,
    combinedBytes: 33554432,
    cacheEntries: 128,
    cacheBytes: 67108864
  });
  for (const invalid of [0, -1, Infinity, NaN, 1.5])
    assert.throws(() => nativeLimits({ requests: invalid }));
  const budget = new NativeQueryBudget(
    nativeLimits({
      responseBytes: Buffer.byteLength(payload),
      combinedBytes: Buffer.byteLength(payload) * 2,
      requests: 3
    })
  );
  try {
    await budget.fetch("http://test", new URLSearchParams(), upstream());
    await budget.fetch("http://test", new URLSearchParams(), upstream());
    await assert.rejects(
      budget.fetch("http://test", new URLSearchParams(), upstream()),
      /combined_budget_exceeded/
    );
  } finally {
    budget.close();
  }
  const responseBudget = new NativeQueryBudget(
    nativeLimits({ responseBytes: Buffer.byteLength(payload) - 1 })
  );
  try {
    await assert.rejects(
      responseBudget.fetch("http://test", new URLSearchParams(), upstream()),
      /response_budget_exceeded/
    );
  } finally {
    responseBudget.close();
  }
  const requestBudget = new NativeQueryBudget(nativeLimits({ requests: 1 }));
  try {
    await requestBudget.fetch("http://test", new URLSearchParams(), upstream());
    await assert.rejects(
      requestBudget.fetch("http://test", new URLSearchParams(), upstream()),
      /request_budget_exceeded/
    );
  } finally {
    requestBudget.close();
  }
});
it("bounds all concurrent requests and aborts queued/in-flight work on a whole-query deadline", async () => {
  let active = 0,
    peak = 0;
  const budget = new NativeQueryBudget(nativeLimits({ deadlineMs: 40, concurrency: 4 }));
  const fetcher = async (_url: any, options: any) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((_, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true
        })
      );
      return new Response(payload);
    } finally {
      active--;
    }
  };
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => budget.fetch("http://test", new URLSearchParams(), fetcher))
    );
    assert.equal(peak, 4);
    assert.equal(active, 0);
    assert.ok(results.every((r) => r.status === "rejected"));
  } finally {
    budget.close();
  }
});
it("checks the deadline during normalization as well as network work", () => {
  let now = 0;
  const budget = new NativeQueryBudget(nativeLimits({ deadlineMs: 30 }), () => now);
  now = 30;
  assert.throws(() => budget.check(), /deadline_exceeded/);
  budget.close();
});
it("accounts UTF-8 serialized LRU payloads before insertion and bypasses oversized entries", () => {
  const cache = new NativeMatrixCache(nativeLimits({ cacheEntries: 2, cacheBytes: 20 }));
  cache.set("a", "é");
  assert.equal(cache.accountedBytes, 4);
  cache.set("b", "ab");
  cache.get("a");
  cache.set("c", "x");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.size, 2);
  cache.set("a", "abcdef");
  assert.equal(cache.accountedBytes, 11);
  cache.set("large", "x".repeat(30));
  assert.equal(cache.get("large"), undefined);
  assert.equal(cache.size, 2);
  cache.set("d", "123456789012345");
  assert.equal(cache.size, 1);
  assert.equal(cache.accountedBytes, 17);
});
it("cancels a stalled response body even when an upstream ignores cancellation", async () => {
  const budget = new NativeQueryBudget(nativeLimits({ deadlineMs: 20 }));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"status":'));
    }
  });
  try {
    await assert.rejects(
      budget.fetch("http://test", new URLSearchParams(), async () => new Response(stream)),
      /deadline_exceeded/
    );
  } finally {
    budget.close();
  }
});

import { createGrafanaDatasource } from "../../../apps/control-plane/src/grafana/prom-api";
import golden from "../../fixtures/benchmark-readiness/native-series.json";
import { ALIGNED_ANCHOR_MS } from "../../../apps/control-plane/src/grafana/alignment";
const runId = golden.timeline.runId;
const timeline = {
  runId,
  startedAt: golden.timeline.startedAt,
  endedAt: golden.timeline.endedAt,
  measurementStart: 1800000040000,
  nativePublisher: "endpoint",
  phases: Object.entries(golden.timeline.phases).map(([phase, [start, end]]) => ({
    phase,
    start: start * 1000,
    end: end * 1000
  }))
} as any;
const raw = (name: string, value: number, phase = "warmup", run = runId, epoch?: string) => ({
  metric: {
    __name__: "parkbench_openedge_db_" + name,
    run_id: run,
    pool: "primary",
    job: "parkbench-runs",
    phase,
    ...(epoch ? { database_epoch: epoch } : {})
  },
  values: [[1800000020, String(value)]]
});
const descriptor = (metric: string, view: string, start = 1800000020000, end = 1800000025000) =>
  `parkbench_db_diagnostic{run_id="${runId}",metric="${metric}",view="${view}",phase="warmup",window_start="${start}",window_end="${end}"}`;
it("serves canonical derived free capacity and hit ratio through exact-scoped instant/range routes", async () => {
  let requests = 0;
  const input = [
    raw("buffer_pool_configured_buffers", 100),
    raw("buffer_pool_active_buffers", 10),
    raw("buffer_pool_active_buffers", 99, "idle"),
    raw("buffer_pool_active_buffers", 42, "measurement"),
    raw("buffer_pool_active_buffers", 75, "cooldown"),
    raw("buffer_pool_logical_reads_total", 1000, "warmup", runId, "epoch1"),
    raw("buffer_pool_os_reads_total", 100, "warmup", runId, "epoch1")
  ];
  const proxy = createGrafanaDatasource({
    prometheusUrl: "http://test",
    timelines: { get: () => timeline, list: () => [timeline] },
    log: () => {},
    fetch: async (_url, options) => {
      requests++;
      const query = new URLSearchParams(String(options?.body)).get("query")!;
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: input.filter((s) => query.includes(s.metric.__name__))
          }
        })
      );
    }
  });
  const query = new URLSearchParams({
    query: descriptor("free_capacity", "gauge"),
    start: "1800000020",
    end: "1800000025",
    step: "5"
  });
  const free = await proxy.dataQuery(query, false);
  assert.equal(free.status, 200);
  const rows = (free.body as any).data.result;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].values, [
    [1800000020, "90"],
    [1800000025, "90"]
  ]);
  await proxy.dataQuery(query, false);
  assert.equal(requests, 1, "immutable repeated raw matrix reuses cache");
  const hit = await proxy.dataQuery(
    new URLSearchParams({
      query: descriptor("cumulative_hit_ratio", "cumulative"),
      time: "1800000020"
    }),
    true
  );
  assert.equal((hit.body as any).data.result[0].value[1], "0.9");
  const bad = await proxy.dataQuery(
    new URLSearchParams({ query: descriptor("anything);sum(up)", "gauge"), time: "1800000020" }),
    true
  );
  assert.equal(bad.status, 400);
  const scope = await proxy.dataQuery(
    new URLSearchParams({
      query: descriptor("free_capacity", "gauge").replace(`run_id="${runId}",`, ""),
      time: "1800000020"
    }),
    true
  );
  assert.equal(scope.status, 400);
});
it("keeps conflicting canonical values unavailable and maps each epoch/run to aligned output independently", async () => {
  const measurement = [
    ...Array.from({ length: 3 }, (_, i) => ({
      metric: {
        __name__: "parkbench_openedge_db_buffer_pool_logical_reads_total",
        run_id: runId,
        pool: "primary",
        database_epoch: i === 2 ? "second" : "first",
        job: "parkbench-runs",
        phase: "measurement",
        instance: String(i)
      },
      values: [
        [1800000040, i === 1 ? "101" : "100"],
        [1800000045, i === 1 ? "151" : "150"],
        [1800000050, i === 1 ? "201" : "200"]
      ]
    }))
  ];
  const proxy = createGrafanaDatasource({
    prometheusUrl: "http://test",
    timelines: { get: (id) => ({ ...timeline, runId: id }), list: () => [timeline] },
    log: () => {},
    fetch: async (_url, options) => {
      const run = /run_id="([^"]+)"/.exec(
        new URLSearchParams(String(options?.body)).get("query")!
      )![1];
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: measurement.map((s) => ({ ...s, metric: { ...s.metric, run_id: run } }))
          }
        })
      );
    }
  });
  const query = descriptor(
    "buffer_pool_logical_reads_total",
    "total",
    ALIGNED_ANCHOR_MS,
    ALIGNED_ANCHOR_MS + 10000
  )
    .replace(`run_id="${runId}"`, `run_id=~"${runId}|second-run"`)
    .replace('phase="warmup"', 'phase="measurement"');
  const result = await proxy.dataQuery(
    new URLSearchParams({ query, time: String((ALIGNED_ANCHOR_MS + 10000) / 1000) }),
    true
  );
  assert.equal(result.status, 200);
  const rows = (result.body as any).data.result;
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((r: any) => r.metric.run_id === runId).length, 2);
  assert.equal(rows.filter((r: any) => r.metric.run_id === "second-run").length, 2);
  assert.equal(rows.find((r: any) => r.metric.database_epoch === "first").value[1], "NaN");
  assert.equal(rows.find((r: any) => r.metric.database_epoch === "second").value[1], "100");
  assert.equal(rows[0].value[0], (ALIGNED_ANCHOR_MS + 10000) / 1000);
});

import { startFixturePrometheus } from "./support/fixture-prometheus";
import { counterWindow } from "../../../apps/control-plane/src/grafana/native-counter-window";
it(
  "matches a real Prometheus 3.5 reset/extrapolation oracle for adequately covered counters",
  { skip: process.env.PARKBENCH_RUN_GRAFANA_INTEGRATION !== "1", timeout: 90000 },
  async () => {
    const start = Math.floor(Date.now() / 1000) - 3600;
    const cases = [
      ...golden.counterCases.filter((c) => c.expectedAvailable !== false),
      {
        name: "left-open-reset",
        samples: [
          [0, 500],
          [5, 100],
          [10, 110]
        ],
        expectedIncrease: 20,
        expectedRate: 2
      }
    ];
    const text =
      cases
        .flatMap((c) =>
          c.samples.map(([t, v]) => `native_counter_total{case="${c.name}"} ${v} ${start + t}`)
        )
        .join("\n") + "\n# EOF\n";
    const prom = await startFixturePrometheus(text);
    try {
      for (const c of cases) {
        const expression = `increase(native_counter_total{case="${c.name}"}[10s])`;
        const response = await fetch(
          prom.url +
            "/api/v1/query?" +
            new URLSearchParams({ query: expression, time: String(start + 10) })
        );
        const body = (await response.json()) as any;
        assert.equal(body.status, "success");
        const expected = Number(body.data.result[0].value[1]);
        assert.equal(
          counterWindow(c.samples as [number, number | null][], 0, 10, 5)?.increase,
          expected,
          c.name
        );
      }
    } finally {
      prom.stop();
    }
  }
);
it("rolls back every cache insertion when a whole-query cache deadline fails", () => {
  const cache = new NativeMatrixCache(nativeLimits({ cacheEntries: 2 }));
  cache.set("old", [1]);
  let calls = 0;
  assert.throws(
    () =>
      cache.setBatch(
        [
          ["first", [2]],
          ["second", [3]]
        ],
        () => {
          if (++calls === 4) throw new Error("deadline");
        }
      ),
    /deadline/
  );
  assert.equal(cache.size, 1);
  assert.deepEqual(cache.get("old"), [1]);
  assert.equal(cache.get("first"), undefined);
  assert.equal(cache.accountedBytes, 3);
});

it("bounds effective native fetch coordinates before upstream work including custom limits and instant timestamps", async () => {
  let requests = 0;
  const proxy = createGrafanaDatasource({
    prometheusUrl: "http://test",
    nativeDiagnosticsLimits: { windowMs: 10000 },
    timelines: { get: () => timeline, list: () => [timeline] },
    log: () => {},
    fetch: async (_url, options) => {
      requests++;
      const query = new URLSearchParams(String(options?.body)).get("query")!;
      const range = Number(/\[(\d+)ms\]/.exec(query)![1]);
      assert.ok(
        range <= 10000 + 20000 + 5000,
        "only bounded cadence lookback may extend selected scope"
      );
      return new Response(
        JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } })
      );
    }
  });
  const from = 1800000020000;
  const expression = (end = from + 10000) => descriptor("free_capacity", "gauge", from, end) + "";
  const query = (end = from + 10000) =>
    expression(end).replace('view="gauge"', 'view="gauge",rate_window_ms="1000"');
  for (const [start, end] of [
    [from - 1, from + 10000],
    [from, from + 10001],
    [from + 20000, from + 30000]
  ]) {
    const result = await proxy.dataQuery(
      new URLSearchParams({
        query: query(),
        start: String(start / 1000),
        end: String(end / 1000),
        step: "5"
      }),
      false
    );
    assert.equal(result.status, 400);
  }
  for (const time of [from - 1, from + 10001, from + 864000000]) {
    const result = await proxy.dataQuery(
      new URLSearchParams({ query: query(), time: String(time / 1000) }),
      true
    );
    assert.equal(result.status, 400);
  }
  const over = await proxy.dataQuery(
    new URLSearchParams({ query: query(from + 10001), time: String(from / 1000) }),
    true
  );
  assert.equal(over.status, 400);
  const distantGrid = await proxy.dataQuery(
    new URLSearchParams({
      query: query(),
      start: "0",
      end: String((from + 10000) / 1000),
      step: "2000000000"
    }),
    false
  );
  assert.equal(
    distantGrid.status,
    400,
    "an oversized step cannot disguise a distant leading timestamp"
  );
  assert.equal(requests, 0);
  const exact = await proxy.dataQuery(
    new URLSearchParams({
      query: query(),
      start: String(from / 1000),
      end: String((from + 10000) / 1000),
      step: "5"
    }),
    false
  );
  assert.equal(exact.status, 200);
  const instant = await proxy.dataQuery(
    new URLSearchParams({ query: query(), time: String((from + 10000) / 1000) }),
    true
  );
  assert.equal(instant.status, 200);
  const nonaligned = query()
    .replace(String(from), String(from + 1234))
    .replace(String(from + 10000), String(from + 11234));
  const leading = await proxy.dataQuery(
    new URLSearchParams({
      query: nonaligned,
      start: String(from / 1000),
      end: String((from + 10000) / 1000),
      step: "5"
    }),
    false
  );
  assert.equal(
    leading.status,
    200,
    "Grafana may round only the leading output point down to its step grid"
  );
  const arbitrary = await proxy.dataQuery(
    new URLSearchParams({
      query: nonaligned,
      start: String((from + 1000) / 1000),
      end: String((from + 10000) / 1000),
      step: "5"
    }),
    false
  );
  assert.equal(arbitrary.status, 400, "other points outside the descriptor remain invalid");
  let defaultRequests = 0;
  const defaults = createGrafanaDatasource({
    prometheusUrl: "http://test",
    timelines: { get: () => timeline, list: () => [timeline] },
    log: () => {},
    fetch: async () => {
      defaultRequests++;
      return new Response(
        JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } })
      );
    }
  });
  const defaultQuery = descriptor(
    "free_capacity",
    "gauge",
    from,
    from + NATIVE_QUERY_LIMITS.windowMs
  );
  const defaultExact = await defaults.dataQuery(
    new URLSearchParams({
      query: defaultQuery,
      start: String(from / 1000),
      end: String((from + NATIVE_QUERY_LIMITS.windowMs) / 1000),
      step: "3600"
    }),
    false
  );
  assert.equal(defaultExact.status, 200, "the exact default 31-day window remains supported");
  const defaultOver = await defaults.dataQuery(
    new URLSearchParams({
      query: defaultQuery,
      start: String(from / 1000),
      end: String((from + NATIVE_QUERY_LIMITS.windowMs + 1) / 1000),
      step: "3600"
    }),
    false
  );
  assert.equal(defaultOver.status, 400);
  assert.equal(defaultRequests, 1, "one-over output bounds are rejected before upstream work");
  const slowTimeline = { ...timeline, nativeRefreshSeconds: 1000000000 };
  const slowCadence = createGrafanaDatasource({
    prometheusUrl: "http://test",
    nativeDiagnosticsLimits: { windowMs: 10000 },
    timelines: { get: () => slowTimeline, list: () => [slowTimeline] },
    log: () => {},
    fetch: async (_url, options) => {
      const rawQuery = new URLSearchParams(String(options?.body)).get("query")!;
      assert.ok(
        Number(/\[(\d+)ms\]/.exec(rawQuery)![1]) <= 30000,
        "cadence padding is capped by the configured window too"
      );
      return new Response(
        JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } })
      );
    }
  });
  const slowResult = await slowCadence.dataQuery(
    new URLSearchParams({
      query: query(),
      start: String(from / 1000),
      end: String((from + 10000) / 1000),
      step: "5"
    }),
    false
  );
  assert.equal(slowResult.status, 200);
});

it("retains the observed startup anchor despite scrape jitter in all four Run Summary totals", async () => {
  const base = 1790969000;
  const runId = "startup-jitter";
  const timeline = {
    runId,
    startedAt: base * 1000,
    endedAt: (base + 70.5) * 1000,
    measurementStart: (base + 48.167) * 1000,
    continuousMetrics: true,
    nativePublisher: "endpoint" as const,
    nativeRefreshSeconds: 5,
    phases: [
      { phase: "warmup" as const, start: (base + 43.167) * 1000, end: (base + 48.167) * 1000 },
      { phase: "measurement" as const, start: (base + 48.167) * 1000, end: (base + 58.167) * 1000 },
      { phase: "cooldown" as const, start: (base + 58.167) * 1000, end: (base + 63.167) * 1000 },
    ],
  };
  const offsets = [33.292, 38.945, 43.471, 48.636, 53.505, 58.513, 63.521, 69.029];
  for (const condition of [
    "covered",
    "zero",
    "gap",
    "null-anchor",
    "late-start",
    "early-end",
  ] as const) {
    const samples: Array<[number, string]> = offsets.map((offset, i) => [
      base + offset,
      condition === "zero"
        ? "0"
        : condition === "null-anchor" && i === 0
          ? "NaN"
          : String(22 + i * 10),
    ]);
    if (condition === "gap") samples.splice(4, 1);
    if (condition === "late-start") samples.splice(0, 4);
    if (condition === "early-end") samples.splice(4);
    const source = [
      ...["index_blocks_read_total", "index_blocks_written_total"].map((name) => ({
        metric: {
          __name__: "parkbench_openedge_db_" + name,
          run_id: runId,
          job: "parkbench-runs",
          database_epoch: "opaque-jitter",
        },
        values: samples,
      })),
      ...["read", "create", "update", "delete"].map((operation) => ({
        metric: {
          __name__: "parkbench_openedge_db_table_operations_total",
          run_id: runId,
          job: "parkbench-runs",
          database_epoch: "opaque-jitter",
          table: "Customer",
          operation,
        },
        values: samples,
      })),
    ];
    const proxy = createGrafanaDatasource({
      prometheusUrl: "http://test",
      timelines: { get: () => timeline, list: () => [timeline] },
      log: () => {},
      fetch: async (_url, options) => {
        const query = new URLSearchParams(String(options?.body)).get("query")!;
        const operation = /operation(?:=~|=)"([^"]+)"/.exec(query)?.[1];
        const result = source.filter(
          (series) =>
            query.includes(series.metric.__name__) &&
            (!("operation" in series.metric) ||
              !operation ||
              new RegExp("^(?:" + operation + ")$").test(String(series.metric.operation))),
        );
        return new Response(
          JSON.stringify({ status: "success", data: { resultType: "matrix", result } }),
        );
      },
    });
    for (const metric of [
      "index_blocks_read_total",
      "index_blocks_written_total",
      "read",
      "write",
    ]) {
      const labels = `run_id="${runId}",phase=".*",view="total",window_start="${timeline.startedAt}",window_end="${timeline.endedAt}"`;
      const query =
        metric === "read" || metric === "write"
          ? `parkbench_table_rank{${labels},operation="${metric}"}`
          : `parkbench_db_diagnostic{${labels},metric="${metric}"}`;
      const response = await proxy.dataQuery(
        new URLSearchParams({ query, time: String(timeline.endedAt / 1000) }),
        true,
      );
      assert.equal(response.status, 200, condition + ": " + metric);
      const rows = (response.body as any).data.result;
      assert.equal(rows.length, 1, condition + ": " + metric);
      const expected =
        condition === "covered"
          ? String(metric === "write" ? 210 : 70)
          : condition === "zero"
            ? "0"
            : "NaN";
      assert.equal(rows[0].value[1], expected, condition + ": " + metric);
      assert.equal(rows[0].metric.database_epoch, "opaque-jitter");
      const totalQuery = query.replace(/}$/, ',aggregate="run"}');
      const totalResponse = await proxy.dataQuery(
        new URLSearchParams({ query: totalQuery, time: String(timeline.endedAt / 1000) }), true
      );
      assert.equal(totalResponse.status, 200, "aggregate " + condition + ": " + metric);
      const rangeResponse = await proxy.dataQuery(new URLSearchParams({query:totalQuery,
        start:String(timeline.startedAt / 1000),end:String(timeline.endedAt / 1000),step:"5"}),false);
      assert.equal(rangeResponse.status, 400, "run totals are instant-only");
      assert.deepEqual((totalResponse.body as any).data.result, [{
        metric: { run_id: runId, aggregation: "run_total" },
        value: [timeline.endedAt / 1000, expected]
      }]);
      const repeated = await proxy.dataQuery(new URLSearchParams({ query, time: String(timeline.endedAt / 1000) }), true);
      assert.deepEqual((repeated.body as any).data.result, rows, "Total request leaves breakdown unchanged");
      for (const invalid of [
        query.replace(/}$/, ',aggregate="all"}'),
        query.replace(/}$/, ',aggregate=~"run"}'),
        query.replace(/}$/, ',aggregate="run",aggregate="run"}'),
        totalQuery.replace('view="total"', 'view="rate"'),
        totalQuery.replace(/metric="index_blocks_(read|written)_total"/, 'metric="buffer_pool_logical_reads_total"')
      ]) {
        if (invalid === totalQuery) continue;
        assert.equal((await proxy.dataQuery(new URLSearchParams({query:invalid,time:String(timeline.endedAt / 1000)}),true)).status, 400);
      }

    }
  }
});
