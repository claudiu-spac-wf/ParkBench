import test from "node:test";
import assert from "node:assert/strict";
import { createGrafanaDatasource } from "../../../apps/control-plane/src/grafana/prom-api";
import { generatedDashboards, panelsOf, interpolate } from "../../helpers/dashboards";
import { buildNativeFixture } from "./support/native-fixtures";
import { startFixturePrometheus } from "./support/fixture-prometheus";
import { ALIGNED_ANCHOR_MS } from "../../../apps/control-plane/src/grafana/alignment";
const enabled = process.env.PARKBENCH_RUN_GRAFANA_INTEGRATION === "1";
test(
  "all retained mapped native/workload targets execute against real Prometheus; top-ten identities are fixed and complementary Other reconciles per run",
  { skip: !enabled, timeout: 180000 },
  async () => {
    const fixture = buildNativeFixture(),
      prom = await startFixturePrometheus(fixture.openMetrics);
    try {
      const proxy = createGrafanaDatasource({
        prometheusUrl: prom.url,
        timelines: {
          get: (runId) => ({
            runId,
            startedAt: fixture.start * 1000,
            endedAt: fixture.end * 1000,
            measurementStart: fixture.start * 1000,
            nativePublisher: "endpoint",
            phases: [{phase:"measurement",start:fixture.start*1000,end:fixture.end*1000}]
          }),
          list: () => []
        },
        log: () => undefined
      });
      const evaluate = async (expr: string, aligned = false) => {
        const start = aligned ? ALIGNED_ANCHOR_MS / 1000 : fixture.start,
          end = start + 120;
        const query = interpolate(expr, ["native-a", ...(aligned ? ["native-b"] : [])], 120)
          .replaceAll("$phase", "measurement")
          .replaceAll("$replica", "pas-1")
          .replaceAll("$table", ".*")
          .replaceAll("$__from", String(start * 1000))
          .replaceAll("$__to", String(end * 1000));
        const outcome = await proxy.dataQuery(
          new URLSearchParams({ query, start: String(start), end: String(end), step: "5" }),
          false
        );
        assert.equal(outcome.status, 200, `${expr}: ${JSON.stringify(outcome.body)}`);
        return (outcome.body as any).data.result;
      };
      for (const dashboard of Object.values(generatedDashboards()))
        for (const { panel } of panelsOf(dashboard)) {
          if (
            !panel.parkbench?.legacy ||
            panel.parkbench.legacy.uid === "parkbench-database-parameters" ||
            panel.type === "text"
          )
            continue;
          for (const target of panel.targets ?? []) {
            const rows = await evaluate(target.expr);
            assert.ok(
              rows.length > 0,
              `${dashboard.title}/${panel.title}/${target.refId}: no matching fixture data`
            );
          }
        }
      for (const operation of ["read", "write"]) {
        const rows = await evaluate(
          `parkbench_table_rank{run_id=~"$run_id",phase="measurement",operation="${operation}",view="rate",window_start="$__from",window_end="$__to"}`,
          true
        );
        for (const runId of ["native-a", "native-b"]) {
          const selected = rows.filter((r: any) => r.metric.run_id === runId);
          const names = selected.filter((r: any) => r.metric.table !== "Other");
          assert.equal(names.length, 10);
          assert.equal(names[0].metric.table, operation === "read" ? "table-099" : "table-000");
          const finalTime = Math.max(
            ...selected[0].values.map(([t]: any) => t).filter((t:number) => selected.every((r:any) => Number.isFinite(Number(r.values.find(([time]:any) => time === t)?.[1]))))
          );
          const total = selected.reduce(
            (sum: number, r: any) =>
              sum + Number(r.values.find(([t]: any) => t === finalTime)?.[1] ?? 0),
            0
          );
          assert.ok(
            Math.abs(total - (operation === "read" ? 5053 : 15450)) < 1e-6,
            `total ${total}`
          );
        }
      }
    } finally {
      prom.stop();
    }
  }
);

test(
  "real diagnostic ranking keeps whole-range membership across changing leaders, resets, gaps and tied scores",
  { skip: !enabled, timeout: 180000 },
  async () => {
    const start = Math.floor(Date.now() / 1000) - 900,
      end = start + 120,
      lines: string[] = [];
    for (const operation of ["read", "create", "update", "delete"])
      for (let i = 0; i < 90; i++) {
        const table = `T${String(i).padStart(3, "0")}`;
        let value = 1000;
        for (let t = start - 60; t <= end; t += 5) {
          const offset = t - start,
            rate =
              operation === "read"
                ? i === 0 && offset < 60
                  ? 100
                  : i === 89 && offset >= 60
                    ? 200
                    : i === 10
                      ? 1.00000001
                      : 1
                : i === 80
                  ? 100
                  : 1;
          if (i === 70 && offset === 60) value = 0;
          else value += rate * 5;
          if (i === 50 && offset >= 30 && offset <= 60) continue;
          lines.push(
            `parkbench_openedge_db_table_operations_total{run_id="changing",phase="measurement",job="parkbench-run-observers",table="${table}",operation="${operation}",database_epoch="opaque-A"} ${value} ${t}`
          );
        }
      }
    for (let t = start - 60; t <= end; t += 5)
      lines.push(
        `parkbench_openedge_db_table_operations_total{run_id="changing",phase="measurement",job="parkbench-run-observers",table="other",operation="read",database_epoch="opaque-A"} ${(t - start + 100) * 3} ${t}`
      );
    const prom = await startFixturePrometheus(lines.join("\n") + "\n# EOF\n");
    try {
      const proxy = createGrafanaDatasource({
        prometheusUrl: prom.url,
        timelines: {
          get: (runId) => ({
            runId,
            startedAt: start * 1000,
            endedAt: end * 1000,
            measurementStart: start * 1000,
            nativePublisher: "endpoint",
            phases: [{phase:"measurement",start:start*1000,end:end*1000}]
          }),
          list: () => []
        },
        log: () => undefined
      });
      const evaluate = async (operation: string) => {
        const query = `parkbench_table_rank{run_id="changing",phase="measurement",operation="${operation}",view="rate",window_start="${start * 1000}",window_end="${end * 1000}"}`;
        const response = await proxy.dataQuery(
          new URLSearchParams({ query, start: String(start), end: String(end), step: "5" }),
          false
        );
        assert.equal(response.status, 200);
        return (response.body as any).data.result;
      };
      const reads = await evaluate("read"),
        writes = await evaluate("write"),
        named = reads.filter((r: any) => !r.metric.display_remainder);
      assert.equal(named.length, 10);
      assert.ok(named.some((r: any) => r.metric.table === "T000"));
      assert.ok(named.some((r: any) => r.metric.table === "T089"));
      assert.ok(writes.some((r: any) => r.metric.table === "T080"));
      assert.notDeepEqual(
        named.map((r: any) => r.metric.table),
        writes.filter((r: any) => !r.metric.display_remainder).map((r: any) => r.metric.table)
      );
      for (const series of reads) {
        assert.ok(series.values.every(([, value]: any) => value === "NaN" || Number(value) >= 0));
        assert.ok(series.values.some(([,value]:any) => Number.isFinite(Number(value))));
      }
      const total: any = await (
        await fetch(
          // Independent Prometheus oracle uses four five-second native samples,
          // matching the collector cadence even on a finer dashboard grid.
          `${prom.url}/api/v1/query_range?${new URLSearchParams({ query: 'sum(rate(parkbench_openedge_db_table_operations_total{run_id="changing",phase="measurement",operation="read"}[20s]))', start: String(start), end: String(end), step: "5" })}`
        )
      ).json();
      for (const [time, value] of total.data.result[0].values) {
        const sum = reads.reduce(
          (n: number, r: any) => n + Number(r.values.find(([t]: any) => t === time)?.[1] ?? 0),
          0
        );
        if(Number.isFinite(sum)) assert.ok(Math.abs(sum - Number(value)) < 1e-6, `remainder mismatch at ${time}`);
      }
      const gap: any = await (
        await fetch(
          `${prom.url}/api/v1/query_range?${new URLSearchParams({ query: 'rate(parkbench_openedge_db_table_operations_total{run_id="changing",operation="read",table="T050"}[20s])', start: String(start + 40), end: String(start + 50), step: "5" })}`
        )
      ).json();
      assert.equal(gap.data.result.length, 0);
    } finally {
      prom.stop();
    }
  }
);
