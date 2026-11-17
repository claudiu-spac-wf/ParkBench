import test from "node:test";
import assert from "node:assert/strict";
import { timelineFromRun } from "../../../apps/control-plane/src/grafana/run-timeline";
import { createGrafanaDatasource } from "../../../apps/control-plane/src/grafana/prom-api";

const epoch = 1800000000000;
function proxy(missing = false, storedSeconds = 5, alignmentSeconds?: number, refreshSeconds = 5) {
  const timeline = {
    runId: "cadence-run",
    startedAt: epoch,
    endedAt: epoch + 120000,
    phases: [
      { phase: "warmup", start: epoch, end: epoch + 30000 },
      { phase: "measurement", start: epoch + 30000, end: epoch + 110000 }
    ],
    continuousMetrics: true,
    nativePublisher: "endpoint",
    nativeRefreshSeconds: refreshSeconds,
    prometheusScrapeSeconds: storedSeconds
  } as any;
  const recorded = timelineFromRun({
    id: timeline.runId,
    environmentSnapshot: {
      metricsCollectionMode: "continuous",
      sourceCadences: { prometheusScrapeSeconds: storedSeconds, nativeDatabaseRefreshSeconds: refreshSeconds, observers: [{kind: "openedge_db_v1", publisher: "endpoint"}] },
      ...(alignmentSeconds === undefined ? {} : { nativeScrapeAlignment: { contractVersion: "native-scrape-alignment.v1", cadenceMs: alignmentSeconds * 1000 } })
    }
  } as any);
  Object.assign(timeline, recorded, { startedAt: epoch, endedAt: epoch + 120000, phases: timeline.phases });
  const interval = Math.max(refreshSeconds, alignmentSeconds ?? storedSeconds) * 1000 + 20;
  const values = Array.from(
    { length: Math.ceil(120000 / interval) },
    (_, i) => [(epoch + i * interval) / 1000, String(1000 + i * 50)] as [number, string]
  ).filter(([t]) => !missing || t < (epoch + 65000) / 1000 || t > (epoch + 85000) / 1000);
  return createGrafanaDatasource({
    prometheusUrl: "http://test",
    timelines: { get: () => timeline, list: () => [timeline] },
    log: () => {},
    fetch: async (_url, options) => {
      const query = new URLSearchParams(String(options?.body)).get("query")!;
      const metric = query.includes("table_operations_total")
        ? "table_operations_total"
        : query.includes("buffer_pool_configured_buffers") ? "buffer_pool_configured_buffers" : "index_blocks_read_total";
      const operations =
        metric === "table_operations_total" ? ["read", "create", "update", "delete"] : [undefined];
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: operations
              .filter((operation) => {
                const filter = /operation(?:=|=~)"([^"]+)"/.exec(query)?.[1];
                return !operation || !filter || filter.split("|").includes(operation);
              })
              .map((operation) => ({
                metric: {
                  __name__: "parkbench_openedge_db_" + metric,
                  run_id: "cadence-run",
                  job: "parkbench-runs",
                  service: "database",
                  database_epoch: "one",
                  ...(operation ? { operation, table: "Customer" } : {})
                },
                values: operation && operation !== "read" ? values.map(([t]) => [t, "0"]) : values
              }))
          }
        })
      );
    }
  });
}
function params(query: string) {
  return new URLSearchParams({
    query,
    start: String((epoch + 50000) / 1000),
    end: String((epoch + 100000) / 1000),
    step: "1"
  });
}
const windowLabels = `run_id="cadence-run",phase=".*",window_start="${epoch + 50000}",window_end="${epoch + 100000}"`;
for (const [name, query] of [
  ["table reads", `parkbench_table_rank{${windowLabels},operation="read",view="rate"}`],
  [
    "index reads",
    `parkbench_db_diagnostic{${windowLabels},metric="index_blocks_read_total",view="rate",rate_window_ms="2000"}`
  ],
  ["zero table writes", `parkbench_table_rank{${windowLabels},operation="write",view="rate"}`]
]) {
  test(`${name} use real lookback samples and native cadence on a one-second chart grid`, async () => {
    const result = await proxy().dataQuery(params(query), false);
    assert.equal(result.status, 200);
    const rows = (result.body as any).data.result;
    assert.ok(rows.length > 0);
    assert.ok(
      rows.every(
        (r: any) =>
          r.values.length === 51 && r.values.every((p: any) => Number.isFinite(Number(p[1])))
      ),
      JSON.stringify(rows)
    );
    if (name.startsWith("zero"))
      assert.ok(rows.every((r: any) => r.values.every((p: any) => Number(p[1]) === 0)));
  });
}
test("cadence-aware windows retain a genuine missing observation interval", async () => {
  const result = await proxy(true).dataQuery(
    params(
      `parkbench_db_diagnostic{${windowLabels},metric="index_blocks_read_total",view="rate",rate_window_ms="2000"}`
    ),
    false
  );
  const points = (result.body as any).data.result[0].values;
  assert.ok(points.some((p: any) => p[1] === "NaN"));
  assert.ok(points.some((p: any) => Number.isFinite(Number(p[1]))));
});

for (const [saved, execution] of [[10, undefined], [5, 10], [10, 5]] as const) {
  for (const view of ["rate", "gauge", "table"] as const) {
    test(`${view} respects execution cadence ${execution ?? saved}s with queued cadence ${saved}s`, async () => {
      const query = view === "table"
        ? `parkbench_table_rank{${windowLabels},operation="read",view="rate"}`
        : `parkbench_db_diagnostic{${windowLabels},metric="${view === "gauge" ? "buffer_pool_configured_buffers" : "index_blocks_read_total"}",view="${view}",rate_window_ms="2000"}`;
      const response = await proxy(false, saved, execution).dataQuery(params(query), false);
      assert.equal(response.status, 200);
      const rows = (response.body as any).data.result;
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row: any) => row.values.every((p: any) => Number.isFinite(Number(p[1])))), JSON.stringify(rows));
    });
  }
}
test("recorded 10s execution cadence still rejects a real acquisition gap", async () => {
  const result = await proxy(true, 5, 10).dataQuery(params(
    `parkbench_db_diagnostic{${windowLabels},metric="index_blocks_read_total",view="rate",rate_window_ms="2000"}`
  ), false);
  const points = (result.body as any).data.result[0].values;
  assert.ok(points.some((p: any) => p[1] === "NaN"));
  assert.ok(points.some((p: any) => Number.isFinite(Number(p[1]))));
});

test("slower native acquisition still bounds freshness when scraping is faster", async () => {
  const response = await proxy(false, 5, 5, 10).dataQuery(params(
    `parkbench_db_diagnostic{${windowLabels},metric="index_blocks_read_total",view="rate",rate_window_ms="2000"}`
  ), false);
  const rows = (response.body as any).data.result;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row: any) => row.values.every((p: any) => Number.isFinite(Number(p[1])))));
});
