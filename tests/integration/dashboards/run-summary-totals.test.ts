import test from "node:test";
import assert from "node:assert/strict";
import { createGrafanaDatasource } from "../../../apps/control-plane/src/grafana/prom-api";

const epoch = 1800000000000;
const timeline = {
  runId: "totals-run",
  startedAt: epoch,
  endedAt: epoch + 220000,
  phases: [
    { phase: "warmup", start: epoch + 50000, end: epoch + 80000 },
    { phase: "measurement", start: epoch + 80000, end: epoch + 180000 },
    { phase: "cooldown", start: epoch + 180000, end: epoch + 190000 }
  ],
  continuousMetrics: true,
  nativePublisher: "endpoint",
  nativeRefreshSeconds: 5
} as any;

function proxy(keep: (t: number) => boolean = () => true) {
  return createGrafanaDatasource({
    prometheusUrl: "http://test",
    timelines: { get: () => timeline, list: () => [timeline] },
    log: () => {},
    fetch: async (_url, options) => {
      const query = new URLSearchParams(String(options?.body)).get("query")!;
      const table = query.includes("table_operations_total");
      const write = query.includes("written_total") || query.includes("create|update|delete");
      const operations = table ? (write ? ["create", "update", "delete"] : ["read"]) : [undefined];
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: operations.map((operation) => ({
              metric: {
                __name__:
                  "parkbench_openedge_db_" +
                  (table
                    ? "table_operations_total"
                    : write
                      ? "index_blocks_written_total"
                      : "index_blocks_read_total"),
                run_id: timeline.runId,
                job: "parkbench-runs",
                service: "database",
                database_epoch: "one",
                ...(operation ? { operation, table: "Customer" } : {})
              },
              values: Array.from({ length: 33 }, (_, i) => 40 + i * 5)
                .filter(keep)
                .map((t) => [(epoch + t * 1000) / 1000, String(write ? 0 : 100 + t * 10)])
            }))
          }
        })
      );
    }
  });
}

async function total(
  kind: "table" | "index",
  write = false,
  phase = ".*",
  start = 0,
  end = 220,
  keep: (t: number) => boolean = () => true,
  evaluation = end
) {
  const selector = kind === "table" ? "parkbench_table_rank" : "parkbench_db_diagnostic";
  const metric =
    kind === "table"
      ? `operation="${write ? "write" : "read"}"`
      : `metric="index_blocks_${write ? "written" : "read"}_total"`;
  const query = `${selector}{run_id="totals-run",phase="${phase}",view="total",${metric},window_start="${epoch + start * 1000}",window_end="${epoch + end * 1000}"}`;
  const result = await proxy(keep).dataQuery(
    new URLSearchParams({ query, time: String((epoch + evaluation * 1000) / 1000) }),
    true
  );
  assert.equal(result.status, 200);
  const rows = (result.body as any).data.result;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value[0], (epoch + evaluation * 1000) / 1000);
  return rows[0].value[1];
}

for (const kind of ["table", "index"] as const) {
  test(`${kind} totals count observed idle edges and complete workload phases, including true zero writes`, async () => {
    assert.equal(await total(kind), "1600");
    assert.equal(await total(kind, true), "0");
    assert.equal(await total(kind, false, "measurement"), "1000");
    assert.equal(await total(kind, false, "idle"), "200");
    assert.equal(await total(kind, false, ".*", 55, 175), "1200");
  });
  test(`${kind} totals preserve real gaps and missing active edges as unavailable`, async () => {
    for (const keep of [
      (t: number) => t < 120 || t > 135,
      (t: number) => t >= 90,
      (t: number) => t <= 170
    ])
      assert.equal(await total(kind, false, ".*", 0, 220, keep), "NaN");
    assert.equal(await total(kind, false, ".*", 0, 30), "NaN");
  });
  test(`${kind} totals retain selected-window values at an earlier instant evaluation time`, async () => {
    assert.equal(await total(kind, false, "measurement", 80, 180, () => true, 170), "1000");
  });
}
