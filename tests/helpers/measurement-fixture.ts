import type { MetricSample } from "../../packages/contracts/src/metrics";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import { sharedRawQueryScheduler, RawQueryOptions } from "../../packages/metrics/src/raw-query";
/** Generate only the requested bounded batch, independently of the summary arithmetic. */
export class MeasurementFixtureClient extends MemoryPrometheusClient {
  active = 0;
  maximumConcurrency = 0;
  queryCount = 0;
  maximumSamples = 0;
  constructor(
    readonly runId: string,
    readonly start: number,
    readonly tableCount: number,
    readonly duration = 900,
    readonly replicas = 1
  ) {
    super();
  }
  override async queryRawRange(
    selector: string,
    start: number,
    end: number,
    cadence: number,
    options: RawQueryOptions = {}
  ): Promise<MetricSample[]> {
    return sharedRawQueryScheduler.run(
      async () => {
        if (this.fail) throw new Error("source_unavailable");
        this.queryCount++;
        this.active++;
        this.maximumConcurrency = Math.max(this.maximumConcurrency, this.active);
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          const metric = selector.split("{")[0],
            result: MetricSample[] = [];
          const matchers = [...selector.matchAll(/(\w+)(=~|!=|=)"((?:\\.|[^"\\])*)"/g)].map(
            ([, key, operator, value]) => {
              const decoded = JSON.parse('"' + value + '"');
              return {
                key,
                operator,
                value: decoded,
                pattern: operator === "=~" ? new RegExp("^(?:" + decoded + ")$") : undefined
              };
            }
          );
          const add = (
            labels: Record<string, string>,
            type: "counter" | "gauge",
            value: (offset: number) => number
          ) => {
            if (
              !matchers.every((m) =>
                m.operator === "=~"
                  ? m.pattern!.test(labels[m.key] ?? "")
                  : m.operator === "!="
                    ? (labels[m.key] ?? "") !== m.value
                    : (labels[m.key] ?? "") === m.value
              )
            )
              return;
            for (
              let t = this.start + Math.max(0, Math.ceil((start - this.start) / cadence)) * cadence;
              t <= end;
              t += cadence
            ) {
              if (t === end && !(type === "counter" && options.includeExactEnd)) continue;
              result.push({
                metricName: metric,
                labels: labels as any,
                type,
                value: value(t - this.start),
                timestamp: t,
                source: "fixture"
              });
            }
          };
          if (metric.startsWith("container_"))
            for (const [service, group] of [
              ["control-plane", "platform"],
              ["database", "database"],
              ...Array.from({ length: this.replicas }, (_, i) => [`pas-${i + 1}`, "pas"])
            ]) {
              const labels: Record<string, string> = {
                id: "/docker/" + service,
                service,
                cpu: "total",
                device: "sda",
                interface: "eth0",
                job: group === "platform" ? "cadvisor" : "parkbench-run-owned-cadvisor",
                ...(group === "platform"
                  ? {
                      container_label_com_docker_compose_project: "parkbench-platform",
                      container_label_com_docker_compose_service: service
                    }
                  : {
                      run_id: this.runId,
                      container_label_parkbench_managed: "true",
                      container_label_parkbench_run_id: this.runId,
                      container_label_com_docker_compose_service: service
                    })
              };
              const type = metric.endsWith("_total") ? "counter" : "gauge";
              add(labels, type, (t) =>
                metric === "container_start_time_seconds"
                  ? this.start - 10
                  : metric === "container_memory_working_set_bytes"
                    ? 1000
                    : metric === "container_cpu_usage_seconds_total"
                      ? 1.5 * t
                      : 2 * t
              );
            }
          if (
            metric === "parkbench_openedge_db_metric_available" ||
            metric === "parkbench_openedge_db_table_operations_total"
          )
            for (let i = 0; i < this.tableCount; i++) {
              const table = `Table${String(i).padStart(4, "0")}`;
              const tableMatcher = matchers.find((m) => m.key === "table");
              // A fixture response should allocate only the requested dimension batch.
              if (tableMatcher?.pattern && !tableMatcher.pattern.test(table)) continue;
              for (const [operation, multiplier] of [
                ["read", 1],
                ["create", 2],
                ["update", 3],
                ["delete", 4]
              ] as const) {
                add(
                  {
                    job: "parkbench-runs",
                    run_id: this.runId,
                    database_epoch: "opaque-A",
                    table,
                    operation,
                    measurement: "table_operations_total",
                    reason: "available"
                  },
                  metric.endsWith("_total") ? "counter" : "gauge",
                  (t) => (metric.endsWith("_total") ? t * (i + 1) * multiplier : 1)
                );
              }
            }
          const requiredLabels = {
            job: "parkbench-runs",
            run_id: this.runId,
            phase: "measurement"
          };
          if (metric.startsWith("parkbench_workload_"))
            add(
              { ...requiredLabels, ...(metric.endsWith("_bucket") ? { le: "+Inf" } : {}) },
              "counter",
              (t) => t
            );
          if (metric === "parkbench_openedge_pas_requests_total")
            for (let i = 1; i <= this.replicas; i++)
              add({ ...requiredLabels, replica: `pas-${i}` }, "counter", (t) => t);
          if (metric === "parkbench_openedge_db_database_table_operations_total")
            for (const operation of ["read", "create", "update", "delete"])
              add(
                { ...requiredLabels, operation, database_epoch: "opaque-A" },
                "counter",
                (t) => t
              );
          if (metric.startsWith("node_"))
            add(
              {
                ...requiredLabels,
                service: "node-exporter",
                device: "sda",
                cpu: "0",
                mode: "idle"
              },
              metric.endsWith("_total") ? "counter" : "gauge",
              (t) => (metric.endsWith("_total") ? t : 1000)
            );
          if (metric === "parkbench_file_disk_usage_bytes")
            add({ ...requiredLabels, service: "file-sampler" }, "gauge", () => 1000);
          this.maximumSamples = Math.max(this.maximumSamples, result.length);
          return result;
        } finally {
          this.active--;
        }
      },
      options.priority,
      options.signal
    );
  }
}
