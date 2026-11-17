import test from "node:test";
import assert from "node:assert/strict";
import { createGrafanaDatasource } from "../../../apps/control-plane/src/grafana/prom-api";

const epoch = 1800000000000;
const timeline = {
  runId: "partial-run",
  startedAt: epoch,
  endedAt: epoch + 110000,
  continuousMetrics: true,
  nativePublisher: "endpoint" as const,
  nativeRefreshSeconds: 5,
  prometheusScrapeSeconds: 10,
  phases: [{ phase: "measurement" as const, start: epoch, end: epoch + 100000 }]
};
async function query(
  kind: "latch" | "index" | "table",
  condition = "gap",
  extra = "",
  view = "total",
  instant = true
) {
  const metric =
    kind === "latch"
      ? "latch_named_waits_total"
      : kind === "index"
        ? "index_blocks_read_total"
        : "table_operations_total";
  const labels = {
    __name__: "parkbench_openedge_db_" + metric,
    run_id: timeline.runId,
    job: "parkbench-runs",
    database_epoch: "one",
    service: "database",
    ...(kind === "latch" ? { latch_name: "buffer", latch_type: "shared", latch_id: "1" } : {}),
    ...(kind === "table" ? { table: "Customer", operation: "read" } : {})
  };
  const values = Array.from({ length: 11 }, (_, i) => i * 10)
    .filter((t) =>
      condition === "late-gap"
        ? t !== 70
        : (condition !== "gap" && condition !== "reset") || t !== 40
    )
    .map((t) => [
      (epoch + t * 1000) / 1000,
      condition === "unavailable" || (condition === "null" && t === 40)
        ? "NaN"
        : String(condition === "zero" ? 0 : condition === "reset" && t >= 70 ? t - 65 : t)
    ]);
  if (condition === "zero") values.splice(4, 1);
  const source = [{ metric: labels, values }];
  if (kind === "latch")
    source.push({
      metric: {
        ...labels,
        __name__: "parkbench_openedge_db_metric_available",
        measurement: metric,
        reason: "available"
      } as any,
      values: values.map(([t]) => [t, "1"])
    });
  const proxy = createGrafanaDatasource({
    prometheusUrl: "http://test",
    timelines: { get: () => timeline, list: () => [timeline] },
    log: () => {},
    fetch: async () =>
      new Response(
        JSON.stringify({ status: "success", data: { resultType: "matrix", result: source } })
      )
  });
  const expr = `${kind === "table" ? "parkbench_table_rank" : "parkbench_db_diagnostic"}{run_id="partial-run",phase="measurement",view="${view}",${kind === "table" ? 'operation="read"' : `metric="${metric}"`},window_start="${epoch}",window_end="${epoch + 100000}"${extra}}`;
  const response = await proxy.dataQuery(
    new URLSearchParams(
      instant
        ? { query: expr, time: String((epoch + 100000) / 1000) }
        : {
            query: expr,
            start: String(epoch / 1000),
            end: String((epoch + 100000) / 1000),
            step: "10"
          }
    ),
    instant
  );
  assert.equal(response.status, 200);
  return (response.body as any).data.result;
}
for (const kind of ["latch", "index", "table"] as const) {
  test(`${kind} totals retain observed increments without spanning missing/null intervals`, async () => {
    for (const condition of ["gap", "null"]) {
      const rows = await query(kind, condition);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].value[1], "80");
      assert.equal(rows[0].metric.coverage_status, "partial");
      assert.match(rows[0].metric.coverage_note, /partial/i);
      const aggregate = await query(
        kind,
        condition,
        kind === "latch" ? ',group="name_type"' : ',aggregate="run"'
      );
      assert.equal(aggregate[0].value[1], "80");
      assert.equal(aggregate[0].metric.coverage_status, "partial");
    }
  });
  test(`${kind} partial totals handle observed resets and distinguish zeros from unavailable`, async () => {
    assert.equal((await query(kind, "reset"))[0].value[1], "75");
    const zero = (await query(kind, "zero"))[0];
    assert.equal(zero.value[1], "0");
    assert.equal(zero.metric.coverage_status, "partial");
    const absent = (await query(kind, "unavailable"))[0];
    assert.equal(absent.value[1], "NaN");
    assert.equal(absent.metric.coverage_status, "unavailable");
  });
}

test("instant detail tables use the selected phase's final interior instant", async () => {
  const rows = await query("table", "gap", "", "rate");
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(Number(rows[0].value[1]) - 1) < 0.00001);
  assert.equal(rows[0].value[0], (epoch + 100000) / 1000);
});

test("ranked rate timelines retain real gaps and the exclusive phase boundary", async () => {
  const rows = await query("table", "gap", "", "rate", false);
  const points = rows.find((row: any) => row.metric.table === "Customer").values;
  const at = (seconds: number) => points.find((p: any) => p[0] === epoch / 1000 + seconds)[1];
  assert.equal(at(50), "NaN");
  assert.ok(Number.isFinite(Number(at(80))));
  assert.equal(at(100), "NaN");
});

test("instant rate tables expose supported averages when the lookback contains a gap", async () => {
  for (const kind of ["table", "index", "latch"] as const) {
    const rows = await query(kind, "late-gap", "", "rate");
    assert.equal(rows.length, 1);
    assert.ok(Math.abs(Number(rows[0].value[1]) - 1) < 0.00001);
    assert.equal(rows[0].metric.coverage_status, "partial");
  }
});
