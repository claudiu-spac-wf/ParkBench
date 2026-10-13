import test from "node:test";
import assert from "node:assert/strict";
import { containerPanels } from "../../../packages/dashboards/src/queries/container";
import { startFixturePrometheus } from "./support/fixture-prometheus";

test(
  "container gauges and CPU count the freshest phase once per physical container",
  {
    skip: process.env.PARKBENCH_RUN_GRAFANA_INTEGRATION !== "1",
    timeout: 180_000
  },
  async () => {
    const start = Math.floor(Date.now() / 1000) - 900;
    const lines: string[] = [];
    for (const [phase, from, to, memory, rate] of [
      ["warmup", 0, 35, 200, 0.5],
      ["measurement", 30, 55, 90, 1]
    ] as const) {
      for (let offset = from; offset <= to; offset += 5) {
        const labels = `job="parkbench-run-owned-cadvisor",run_id="phase-run",service="database",id="/docker/owned",phase="${phase}"`;
        lines.push(`container_memory_working_set_bytes{${labels}} ${memory} ${start + offset}`);
        lines.push(
          `container_cpu_usage_seconds_total{${labels},cpu="total"} ${offset * rate} ${start + offset}`
        );
      }
    }
    const prom = await startFixturePrometheus(lines.join("\n") + "\n# EOF\n");
    try {
      for (const [id, expected] of [
        ["summary.memory", 90],
        ["summary.cpu", 100]
      ] as const) {
        const expr = containerPanels("db")
          .summary.find((p) => p.id === id)!
          .targets[0].expr.replaceAll("$run_id", "phase-run")
          .replaceAll("$__rate_interval", "30s");
        const url = new URL("/api/v1/query", prom.url);
        url.searchParams.set("query", expr);
        url.searchParams.set("time", String(start + 55));
        const result: any = await (await fetch(url)).json();
        assert.equal(result.status, "success", JSON.stringify(result));
        assert.equal(result.data.result.length, 1);
        assert.equal(Number(result.data.result[0].value[1]), expected, id);
      }
    } finally {
      prom.stop();
    }
  }
);
