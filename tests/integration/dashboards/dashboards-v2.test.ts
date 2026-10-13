import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGrafanaDatasource } from "../../../apps/control-plane/src/grafana/prom-api";
import { ALIGNED_ANCHOR_MS } from "../../../apps/control-plane/src/grafana/alignment";
import { generatedDashboards, interpolate, panelById } from "../../helpers/dashboards";
import { buildFixture, Fixture } from "./support/fixtures";
import { FixturePrometheus, startFixturePrometheus } from "./support/fixture-prometheus";

const enabled = process.env.PARKBENCH_RUN_GRAFANA_INTEGRATION === "1";
const dashboards = generatedDashboards();

describe(
  "v2 dashboards against fixture Prometheus (FR-027)",
  { skip: !enabled, timeout: 300_000 },
  () => {
    let prometheus: FixturePrometheus;
    let fixture: Fixture;
    let datasource: ReturnType<typeof createGrafanaDatasource>;

    before(async () => {
      fixture = buildFixture();
      prometheus = await startFixturePrometheus(fixture.openMetrics);
      datasource = createGrafanaDatasource({
        prometheusUrl: prometheus.url,
        timelines: {
          get: (id) => fixture.timelines[id],
          list: () => Object.values(fixture.timelines)
        },
        log: () => undefined
      });
    });
    after(() => prometheus?.stop());

    /** Evaluates a panel target the way Grafana would, through the ParkBench Runs datasource. */
    async function evaluate(
      expr: string,
      runs: string[],
      start: number,
      end: number,
      instant = false
    ): Promise<any[]> {
      const query = interpolate(expr, runs, end - start)
        .replaceAll("$phase", ".*")
        .replaceAll("$__from", String(start * 1000))
        .replaceAll("$__to", String(end * 1000));
      const params = new URLSearchParams(
        instant
          ? { query, time: String(end) }
          : { query, start: String(start), end: String(end), step: "5" }
      );
      const outcome = await datasource.dataQuery(params, instant);
      assert.equal(outcome.status, 200, `${query}: ${JSON.stringify(outcome.body)}`);
      return (outcome.body as any).data.result;
    }

    async function prom(expr: string, start: number, end: number, instant = false): Promise<any[]> {
      const query = interpolate(expr, [], end - start);
      const url = instant
        ? `${prometheus.url}/api/v1/query?${new URLSearchParams({ query, time: String(end) })}`
        : `${prometheus.url}/api/v1/query_range?${new URLSearchParams({ query, start: String(start), end: String(end), step: "5" })}`;
      const body = await (await fetch(url)).json();
      assert.equal(body.status, "success", `${query}: ${JSON.stringify(body)}`);
      return body.data.result;
    }

    const labelSet = (result: any[], label: string) =>
      result.map((series) => series.metric[label]).sort();
    const summary = () => dashboards["parkbench-run-summary"];
    const measurement = (w: Fixture["runA"]) => [w.mStart, w.mEnd] as const;

    it("shows the ten named tables plus complementary Other, with exact name ordering", async () => {
      const [start, end] = measurement(fixture.runA);
      const rate = await evaluate(
        panelById(summary(), "rs.table_reads_rate").targets[0].expr,
        ["run_a"],
        start,
        end
      );
      assert.deepEqual(labelSet(rate, "table"), [
        "Customer",
        "Item",
        "Order",
        "OrderLine",
        "Other",
        "Xa",
        "Xb",
        "Xc"
      ]);
      const totals = await evaluate(
        panelById(summary(), "rs.table_reads_total").targets[0].expr,
        ["run_a"],
        start,
        end,
        true
      );
      assert.deepEqual(
        labelSet(totals, "table"),
        labelSet(rate, "table"),
        "rate and totals list the same tables"
      );
      const other = totals.find((series) => series.metric.table === "Other");
      assert.ok(
        Math.abs(Number(other.value[1]) - 3 * 300) < 3 * 20,
        `Other = genuine collected bucket, got ${other.value[1]}`
      );
      for (const series of rate)
        assert.ok(
          series.values.length > 50,
          `${series.metric.table} keeps its identity across the range`
        );
    });

    it("omits Other when ten or fewer tables are active", async () => {
      const [start, end] = measurement(fixture.runB);
      const rate = await evaluate(
        panelById(summary(), "rs.table_writes_rate").targets[0].expr,
        ["run_b"],
        start,
        end
      );
      assert.deepEqual(labelSet(rate, "table"), ["Customer", "Item", "Order", "OrderLine"]);
    });

    it("ranks each run separately on the aligned axis", async () => {
      const start = (ALIGNED_ANCHOR_MS - 60_000) / 1000;
      const end = (ALIGNED_ANCHOR_MS + 300_000) / 1000;
      const rate = await evaluate(
        panelById(summary(), "rs.table_reads_rate").targets[0].expr,
        ["run_a", "run_b"],
        start,
        end
      );
      const byRun = (run: string) =>
        rate
          .filter((s) => s.metric.run_id === run)
          .map((s) => s.metric.table)
          .sort();
      assert.deepEqual(byRun("run_a"), [
        "Customer",
        "Item",
        "Order",
        "OrderLine",
        "Other",
        "Xa",
        "Xb",
        "Xc"
      ]);
      assert.deepEqual(byRun("run_b"), ["Customer", "Item", "Order", "OrderLine"]);
      for (const series of rate)
        assert.ok(
          series.values.every(([t]: [number]) => t >= start && t <= end),
          "timestamps are on the elapsed axis"
        );
      const narrowed = await evaluate(
        panelById(summary(), "rs.table_reads_total").targets[0].expr,
        ["run_a", "run_b"],
        ALIGNED_ANCHOR_MS / 1000,
        ALIGNED_ANCHOR_MS / 1000 + 15,
        true
      );
      assert.ok(
        narrowed.some((s) => s.metric.run_id === "run_a") &&
          narrowed.some((s) => s.metric.run_id === "run_b")
      );
    });

    it("shows PAS requests and failures per replica and a combined ABL average", async () => {
      const [start, end] = measurement(fixture.runA);
      const requests = await evaluate(
        panelById(summary(), "rs.pas_requests").targets[0].expr,
        ["run_a"],
        start,
        end
      );
      assert.deepEqual(labelSet(requests, "replica"), ["pas-1", "pas-2"]);
      const cpu = await evaluate(
        panelById(summary(), "rs.pas_cpu").targets[0].expr,
        ["run_a"],
        start,
        end
      );
      assert.deepEqual(
        labelSet(cpu, "service"),
        labelSet(requests, "replica"),
        "container and observer replicas line up"
      );
      const abl = await evaluate(
        panelById(summary(), "rs.abl_time").targets[0].expr,
        ["run_a"],
        start,
        end
      );
      assert.equal(abl.length, 1);
      const value = Number(abl[0].values.at(-5)[1]);
      assert.ok(
        Math.abs(value - (100 * 0.01 + 50 * 0.04) / 150) < 0.001,
        `request-weighted average, got ${value}`
      );
    });

    it("scopes DB and Run Resources and limits containers to the top ten plus Other", async () => {
      const { start, end } = fixture.runA;
      const run = dashboards["parkbench-run-resources"];
      const seconds = await evaluate(
        panelById(run, "cpu.seconds_by_container").targets[0].expr,
        ["run_a"],
        start,
        end,
        true
      );
      assert.equal(seconds.length, 11);
      assert.ok(labelSet(seconds, "service").includes("Other"));
      assert.ok(!labelSet(seconds, "service").includes("database"));
      const fewer = await evaluate(
        panelById(run, "cpu.seconds_by_container").targets[0].expr,
        ["run_b"],
        fixture.runB.start,
        fixture.runB.end,
        true
      );
      assert.deepEqual(labelSet(fewer, "service"), ["loadgen", "pas-1", "pas-observer"]);
      const perCore = await evaluate(
        panelById(run, "cpu.per_core").targets[0].expr,
        ["run_a"],
        start,
        end
      );
      assert.deepEqual(labelSet(perCore, "cpu"), ["cpu00", "cpu01"]);
      const db = dashboards["parkbench-db-resources"];
      const dbMemory = await evaluate(
        panelById(db, "memory.by_container").targets[0].expr,
        ["run_a"],
        start,
        end
      );
      assert.deepEqual(labelSet(dbMemory, "service"), ["database"]);
      const limits = await evaluate(
        panelById(db, "memory.by_container").targets[3].expr,
        ["run_a"],
        start,
        end
      );
      assert.equal(limits.length, 1, "limit line only where a limit is set");
      const runLimits = await evaluate(
        panelById(run, "memory.by_container").targets[3].expr,
        ["run_a"],
        start,
        end
      );
      assert.equal(runLimits.length, 0);
      const reset = await evaluate(
        panelById(run, "summary.cpu").targets[0].expr,
        ["run_a"],
        start,
        end
      );
      assert.ok(
        reset[0].values.every(([, v]: [number, string]) => Number(v) >= 0),
        "no negative rate across a counter reset"
      );
    });

    it("keeps Host and Platform on the ambient scrapes and physical devices", async () => {
      const end = fixture.base + 3000;
      const start = end - 1800;
      const host = dashboards["parkbench-host-resources"];
      const disks = await prom(panelById(host, "summary.disk").targets[0].expr, start, end);
      assert.deepEqual(labelSet(disks, "device"), ["nvme0n1", "sda"]);
      const read = Number(disks[0].values.at(-1)[1]);
      assert.ok(
        Math.abs(read - 1024 * 1024) < 1024,
        `no doubling from the run-tagged scrape, got ${read}`
      );
      const network = await prom(panelById(host, "summary.network").targets[0].expr, start, end);
      assert.deepEqual(labelSet(network, "device"), ["eth0"]);
      const cores = await prom(panelById(host, "cpu.per_core").targets[0].expr, start, end);
      assert.equal(cores.length, 4);
      const gapStart = fixture.base + 1860;
      const gap = cores[0].values.filter(([t]: [number]) => t > gapStart && t < gapStart + 30);
      assert.equal(gap.length, 0, "missing samples stay a gap");
      const platform = dashboards["parkbench-platform-resources"];
      const memory = await prom(panelById(platform, "summary.memory").targets[0].expr, start, end);
      assert.equal(memory.length, 1);
      assert.equal(
        Number(memory[0].values.at(-1)[1]),
        2.1e9,
        "six platform services, counted once"
      );
    });

    it("returns only the mode-mismatch notice for a clock range with several runs", async () => {
      const { start, end } = fixture.runA;
      const data = await evaluate(
        panelById(summary(), "rs.db_cpu").targets[0].expr,
        ["run_a", "run_b"],
        start,
        end
      );
      assert.deepEqual(data, []);
      const notice = await evaluate(
        'parkbench_run_mode_mismatch{run_id=~"$run_id"}',
        ["run_a", "run_b"],
        start,
        end,
        true
      );
      assert.equal(notice[0].metric.expected, "aligned");
    });
  }
);
