import { namedLatchOpenMetrics } from "../../../helpers/named-latch-grafana";
import catalog from "../../../../packages/contracts/src/openedge-db-metric-catalog.json";
import frozen from "../../../fixtures/grafana-dashboards/coverage/legacy-v1.json";
/** All reviewed native/workload families, actual opaque epochs, 100 arbitrary table names. */
export function buildNativeFixture() {
  const start = Math.floor(Date.now() / 1000) - 1800,
    end = start + 120;
  const families = new Map<string, string[]>();
  const add = (
    name: string,
    labels: Record<string, string>,
    value: (time: number) => number | undefined
  ) => {
    const lines = families.get(name) ?? [];
    for (let t = start - 60; t <= end; t += 5) {
      const v = value(t);
      if (v === undefined) continue;
      lines.push(
        `${name}{${Object.entries(labels)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(",")}} ${v} ${t}`
      );
    }
    families.set(name, lines);
  };
  const names = new Set<string>();
  for (const m of frozen.mappings)
    for (const t of (m.panel as any).targets ?? [])
      for (const metric of t.expr.match(
        /\b(?:parkbench_[a-z_]+|container_[a-z_]+|node_[a-z_]+)\b/g
      ) ?? [])
        names.add(metric);
  for (const entry of catalog.entries.filter((e) => !("sinceProtocol" in e)))
    names.add(`parkbench_openedge_db_${entry.name}`);
  for (const [runId, shift] of [
    ["native-a", 0],
    ["native-b", 0]
  ] as const) {
    for (const metric of names) {
      if (
        metric.includes("parameter_snapshot_") ||
        metric === "parkbench_openedge_db_table_operations_total"
      )
        continue;
      const entry = catalog.entries.find((e) => metric === `parkbench_openedge_db_${e.name}`);
      const labels: any = {
        run_id: runId,
        phase: "measurement",
        service: metric.startsWith("node_")
          ? "node-exporter"
          : metric.startsWith("parkbench_openedge_pas_")
            ? "pas-1"
            : "database",
        replica: "pas-1",
        job: metric.startsWith("container_")
          ? "parkbench-run-owned-cadvisor"
          : metric.startsWith("node_")
            ? "parkbench-runs"
            : "parkbench-run-observers",
        id: "/docker/native-database",
        cpu: "total",
        device: "sda",
        interface: "eth0",
        operation: "read",
        database_epoch: "opaque-A",
        database: "actual-db"
      };
      for (const d of entry?.dimensions ?? [])
        labels[d] =
          (
            {
              pool: "primary",
              index: "actual-index",
              operation: "read",
              direction: "write",
              database_epoch: "opaque-A"
            } as any
          )[d] ?? "actual-object";
      if (metric.includes("_metric_available"))
        Object.assign(labels, {
          measurement: "table_operations_total",
          table: "table-000",
          family: "table_activity",
          reason: "available",
          source: "_TableStat"
        });
      if (metric.endsWith("_bucket")) {
        for (const [le, value] of [
          ["0.1", 1],
          ["1", 2],
          ["+Inf", 3]
        ])
          add(metric, { ...labels, le }, (t) => (t - start + 60) * Number(value));
      } else {
        if (metric === "parkbench_openedge_db_metric_available") {
          for (const family of ["buffer_pool", "index_activity", "table_activity"])
            add(metric, { ...labels, family, reason: "available" }, () => 1);
          continue;
        }
        const value = (t: number) =>
          metric.endsWith("_total")
            ? (t - start + 60) * 2
            : metric.includes("cache_hit_ratio")
              ? 0.75
              : metric.includes("available")
                ? 1
                : 3;
        add(metric, labels, value);
        if (metric.startsWith("container_"))
          add(metric, { ...labels, service: "pas-1", id: "/docker/native-pas-1" }, value);
      }
    }
    for (let i = 0; i < 100; i++)
      for (const operation of ["read", "create", "update", "delete", "os_read"]) {
        const rate = operation === "read" ? i + 1 : 101 - i;
        const table = `table-${String(i).padStart(3, "0")}`;
        add(
          "parkbench_openedge_db_table_operations_total",
          {
            run_id: runId,
            phase: "measurement",
            service: "database",
            job: "parkbench-run-observers",
            table,
            operation,
            database_epoch: "opaque-A"
          },
          (t) => (t - start + 60) * rate
        );
      }
    add(
      "parkbench_openedge_db_table_operations_total",
      {
        run_id: runId,
        phase: "measurement",
        service: "database",
        job: "parkbench-run-observers",
        table: "other",
        operation: "read",
        database_epoch: "opaque-A"
      },
      (t) => (t - start + 60) * 3
    );
  }
  return {
    start,
    end,
    openMetrics:
      [...families.values()].flat().join("\n") +
      "\n" +
      namedLatchOpenMetrics(start, end) +
      "# EOF\n"
  };
}
