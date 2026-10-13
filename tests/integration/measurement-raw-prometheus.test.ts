import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HttpPrometheusClient,
  MemoryPrometheusClient,
  parsePrometheusResponse
} from "../../packages/metrics/src/prometheus-client";
import { resolveResourceMembership } from "../../packages/metrics/src/resource-membership";
import { readRawChunks, RawQueryScheduler } from "../../packages/metrics/src/raw-query";
describe("stored timestamp raw acquisition", () => {
  it("uses instant padded range vectors, filters left-open bounds and never invents query-grid timestamps", async () => {
    const original = globalThis.fetch;
    const requests: URL[] = [];
    globalThis.fetch = async (url: any) => {
      requests.push(new URL(url));
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: {
                  __name__: "container_cpu_usage_seconds_total",
                  cpu: "total",
                  run_id: "r"
                },
                values: [
                  [0.999, "0"],
                  [1, "10"],
                  [1.4, "11"],
                  [2, "12"]
                ]
              }
            ]
          }
        })
      );
    };
    try {
      const c = new HttpPrometheusClient("http://fixture");
      const samples = await c.queryRawRange(
        'container_cpu_usage_seconds_total{run_id="r"}',
        1,
        2,
        1
      );
      assert.deepEqual(
        samples.map((s) => s.timestamp),
        [1, 1.4]
      );
      assert.equal(samples[0].metricName, "container_cpu_usage_seconds_total");
      assert.equal(requests[0].pathname, "/api/v1/query");
      assert.ok(requests[0].searchParams.get("query").endsWith("[1001ms]"));
      assert.equal(requests[0].searchParams.get("time"), "2");
      const end = await c.queryRawRange('container_cpu_usage_seconds_total{run_id="r"}', 1, 2, 1, {
        includeExactEnd: true
      });
      assert.equal(end.length, 3);
    } finally {
      globalThis.fetch = original;
    }
  });
  it("preserves Docker ownership provenance in raw reads for logical inventory matching", () => {
    const [sample] = parsePrometheusResponse(
      {
        data: {
          result: [
            {
              metric: {
                __name__: "container_start_time_seconds",
                id: "/docker/actual-hash",
                service: "pas-2",
                run_id: "r",
                container_label_parkbench_managed: "true",
                container_label_parkbench_run_id: "r",
                container_label_com_docker_compose_service: "pas-2"
              },
              values: [[1, "0"]]
            }
          ]
        }
      },
      true
    );
    assert.equal(sample.labels.container_label_parkbench_managed, "true");
    assert.equal(sample.labels.container_label_parkbench_run_id, "r");
    assert.equal(
      resolveResourceMembership([sample], "r", 0, 5, 1, [
        { resourceType: "container", resourceId: "pas-2" }
      ]).length,
      1
    );
  });
  it("deduplicates seams and preserves irregular stored timestamps across chunks", async () => {
    const c = new MemoryPrometheusClient(
      [0, 1, 2, 3, 4, 5, 6].map((timestamp) => ({
        metricName: "example_total",
        type: "counter",
        timestamp,
        value: timestamp,
        source: "fixture",
        labels: { run_id: "r" } as any
      }))
    );
    const samples: any[] = [];
    for await (const chunk of readRawChunks(c, 'example_total{run_id="r"}', 0, 6, 1, {
      chunkSeconds: 2,
      includeExactEnd: true
    }))
      samples.push(...chunk.samples);
    assert.deepEqual(
      samples.map((s) => s.timestamp),
      [0, 1, 2, 3, 4, 5, 6]
    );
  });
  it("bounds concurrent requests and gives queued finalization work priority", async () => {
    const scheduler = new RawQueryScheduler(2);
    let active = 0,
      peak = 0;
    const releases: Array<() => void> = [];
    const order: string[] = [];
    const job = (name: string) =>
      scheduler.run(
        async () => {
          active++;
          peak = Math.max(peak, active);
          order.push(name);
          await new Promise<void>((r) => releases.push(r));
          active--;
        },
        name === "final" ? "finalization" : "historical"
      );
    const all = [job("a"), job("b"), job("history"), job("final")];
    await new Promise((r) => setImmediate(r));
    releases.shift()();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order.slice(0, 3), ["a", "b", "final"]);
    releases.shift()();
    await new Promise((r) => setImmediate(r));
    while (releases.length) releases.shift()();
    await Promise.all(all);
    assert.equal(peak, 2);
  });
});

import { startFixturePrometheus } from "./dashboards/support/fixture-prometheus";
it(
  "verifies stored timestamps and exact end behavior in pinned Prometheus v3.5",
  { skip: process.env.PARKBENCH_RUN_GRAFANA_INTEGRATION !== "1", timeout: 120000 },
  async () => {
    const start = Math.floor(Date.now() / 1000) - 1800;
    const times = [start - 0.001, start, start + 0.4, start + 1, start + 1.7, start + 2];
    const text =
      times
        .map((t, i) => `fixture_counter_total{run_id="raw-fixture"} ${100 + i} ${t}`)
        .join("\n") + "\n# EOF\n";
    const fixture = await startFixturePrometheus(text);
    try {
      const c = new HttpPrometheusClient(fixture.url);
      const result = await c.queryRawRange(
        'fixture_counter_total{run_id="raw-fixture"}',
        start,
        start + 2,
        1
      );
      assert.deepEqual(
        result.map((s) => s.timestamp),
        times.slice(1, -1)
      );
      const exact = await c.queryRawRange(
        'fixture_counter_total{run_id="raw-fixture"}',
        start,
        start + 2,
        1,
        { includeExactEnd: true }
      );
      assert.equal(exact.at(-1).timestamp, start + 2);
      const ordinary = await c.queryRange(
        'fixture_counter_total{run_id="raw-fixture"}',
        start,
        start + 2,
        1
      );
      assert.ok(ordinary.length < result.length);
      assert.doesNotMatch(result.map((s) => s.timestamp).join(","), /NaN/);
    } finally {
      fixture.stop();
    }
  }
);
import { boundedResponseJson } from "../../packages/metrics/src/raw-query";
it("splits oversized windows, rejects the smallest batch, and never invents boundary samples", async () => {
  const client = new MemoryPrometheusClient(
    [0, 1, 2, 3, 4].map((timestamp) => ({
      metricName: "fixture_total",
      type: "counter",
      value: timestamp,
      timestamp,
      source: "fixture",
      labels: { run_id: "r" } as any
    }))
  );
  const raw = client.queryRawRange.bind(client);
  let calls = 0;
  client.queryRawRange = async (...args) => {
    calls++;
    if (args[2] - args[1] > 2) throw new Error("summary_limit_exceeded:raw_samples");
    return raw(...args);
  };
  const observations: any[] = [];
  for await (const chunk of readRawChunks(client, 'fixture_total{run_id="r"}', 0, 4, 0.1, {
    includeExactEnd: true
  }))
    observations.push(...chunk.samples);
  assert.deepEqual(
    observations.map((s) => s.timestamp),
    [0, 1, 2, 3, 4]
  );
  assert.ok(calls > 1);
  client.queryRawRange = async () => {
    throw new Error("summary_limit_exceeded:raw_bytes");
  };
  await assert.rejects(async () => {
    for await (const _ of readRawChunks(client, "fixture_total", 0, 0.001, 0.001)) {
    }
  }, /summary_limit_exceeded/);
});
it("enforces raw decoded bytes and sample budgets", async () => {
  await assert.rejects(
    () => boundedResponseJson(new Response("x".repeat(8 * 1024 * 1024 + 1))),
    /raw_bytes/
  );
  const values = Array.from({ length: 100001 }, (_, i) => [i, "0"]);
  await assert.rejects(
    () =>
      boundedResponseJson(
        new Response(
          JSON.stringify({
            status: "success",
            data: {
              resultType: "matrix",
              result: [{ metric: { __name__: "fixture_total" }, values }]
            }
          })
        )
      ),
    /raw_samples/
  );
});
it("cancels queued work immediately before a query slot becomes available", async () => {
  const scheduler = new RawQueryScheduler(1);
  let release: () => void;
  const active = scheduler.run(() => new Promise<void>((resolve) => (release = resolve)));
  const controller = new AbortController();
  let started = false;
  const queued = scheduler.run(
    async () => {
      started = true;
    },
    "historical",
    controller.signal
  );
  controller.abort(new Error("cancelled_fixture"));
  await assert.rejects(
    () =>
      Promise.race([
        queued,
        new Promise((_, reject) => setTimeout(() => reject(new Error("cancel_was_not_prompt")), 50))
      ]),
    /cancelled_fixture/
  );
  release!();
  await active;
  assert.equal(started, false);
});
it("applies the 30-second request timeout and releases the shared query slot", async () => {
  const originalFetch = globalThis.fetch,
    originalTimeout = AbortSignal.timeout,
    requested: number[] = [];
  (AbortSignal as any).timeout = (ms: number) => {
    requested.push(ms);
    return originalTimeout(10);
  };
  globalThis.fetch = async (_url: any, options: any) =>
    new Promise<Response>((_resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true
        });
    });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      () => new HttpPrometheusClient("http://fixture").queryRawRange("fixture_total", 0, 1, 1),
      /query_timeout/
    );
    assert.deepEqual(requested, [30000]);
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

import { buildNativeFixture } from "./dashboards/support/native-fixtures";
import { databaseSummaryRows } from "../../packages/metrics/src/database-summary";
it(
  "retained native raw series preserve every arbitrary table and native-versus-table scope with real stored epochs",
  { skip: process.env.PARKBENCH_RUN_GRAFANA_INTEGRATION !== "1", timeout: 120000 },
  async () => {
    const native = buildNativeFixture(),
      fixture = await startFixturePrometheus(native.openMetrics);
    try {
      const client = new HttpPrometheusClient(fixture.url),
        samples: any[] = [];
      for (const selector of [
        'parkbench_openedge_db_table_operations_total{run_id="native-a"}',
        'parkbench_openedge_db_database_table_operations_total{run_id="native-a"}'
      ])
        for await (const chunk of readRawChunks(client, selector, native.start, native.end, 5, {
          includeExactEnd: true
        }))
          samples.push(...chunk.samples);
      const names = [...new Set(samples.filter((s) => s.labels.table).map((s) => s.labels.table))];
      assert.equal(names.length, 101);
      assert.ok(names.includes("table-099"));
      assert.ok(samples.every((s) => s.labels.database_epoch === "opaque-A"));
      const rows = [
        ...databaseSummaryRows({
          samples,
          inventory: { protocolVersion: 3, tables: names },
          window: { start: native.start, end: native.end },
          cadenceSeconds: 5
        })
      ];
      assert.equal(rows.filter((r) => r.dimensions.table).length, 505);
      assert.equal(
        rows.find((r) => r.definitionId === "db.table.read" && r.dimensions.table === "table-099")
          .statistics.total.observedTotal,
        12000
      );
      const nativeRow = rows.find((r) => r.definitionId === "db.records.read");
      const covered = rows.find((r) => r.definitionId === "db.tables.aggregate.read");
      assert.notEqual(nativeRow.coverageScope, covered.coverageScope);
      assert.notEqual(nativeRow.statistics.total.value, covered.statistics.total.value);
    } finally {
      fixture.stop();
    }
  }
);
