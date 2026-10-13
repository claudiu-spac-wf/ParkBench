import test from "node:test";
import assert from "node:assert/strict";
import { createGrafanaDatasource } from "../../../apps/control-plane/src/grafana/prom-api";

const epoch = 1800000000000;
function proxy(missing = false) {
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
    nativeRefreshSeconds: 5
  } as any;
  const values = Array.from(
    { length: 24 },
    (_, i) => [(epoch + i * 5020) / 1000, String(1000 + i * 50)] as [number, string]
  ).filter(([t]) => !missing || t < (epoch + 65000) / 1000 || t > (epoch + 85000) / 1000);
  return createGrafanaDatasource({
    prometheusUrl: "http://test",
    timelines: { get: () => timeline, list: () => [timeline] },
    log: () => {},
    fetch: async (_url, options) => {
      const query = new URLSearchParams(String(options?.body)).get("query")!;
      const metric = query.includes("table_operations_total")
        ? "table_operations_total"
        : "index_blocks_read_total";
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
