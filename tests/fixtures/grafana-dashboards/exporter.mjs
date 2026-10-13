import fs from "node:fs";
import http from "node:http";

const dashboards = fs
  .readdirSync("/dashboards", { recursive: true })
  .filter((file) => file.endsWith(".json"));
const metrics = new Set();
for (const file of dashboards) {
  const document = fs.readFileSync(`/dashboards/${file}`, "utf8");
  for (const match of document.matchAll(/\b(?:node|container|parkbench)_[a-zA-Z0-9_:]+/g))
    metrics.add(match[0]);
}
metrics.add("parkbench_openedge_db_metric_available");

const body = [];
for (const runId of ["run-a", "run-b"]) {
  const experimentId = runId === "run-a" ? "exp-a" : "exp-b";
  for (const phase of ["measurement", "warmup", "cooldown"]) {
    for (const replica of ["1", "2"]) {
      for (const metric of metrics) {
        if (
          ["parkbench_table_rank", "parkbench_saved_summary"].includes(metric) ||
          metric.startsWith("parkbench_parameter_snapshot_")
        )
          continue;
        if (metric.startsWith("parkbench_openedge_db_")) continue;
        const service = metric.startsWith("node_")
          ? "node-exporter"
          : metric.startsWith("container_")
            ? replica === "1"
              ? "pas-1"
              : "pas-2"
            : metric.startsWith("parkbench_openedge_pas_")
              ? `pas-${replica}`
              : metric.startsWith("parkbench_openedge_db_")
                ? "database"
                : metric.startsWith("parkbench_workload_")
                  ? "loadgen"
                  : "control-plane";
        const labels = {
          experiment_id: experimentId,
          run_id: runId,
          variant_id: "baseline",
          repetition: "1",
          phase,
          replica: `pas-${replica}`,
          service,
          component: service,
          instance: `${service}:9100`
        };
        if (metric.endsWith("_bucket")) labels.le = "+Inf";
        body.push(
          `${metric}{${Object.entries(labels)
            .map(([k, v]) => `${k}="${v}"`)
            .join(",")}} ${phase === "measurement" ? 20 : 1}`
        );
      }
    }
  }
}
body.push(
  'parkbench_openedge_db_buffer_pool_configured_buffers{experiment_id="exp-a",run_id="run-a",variant_id="baseline",repetition="1",phase="measurement",pool="primary",service="database",component="database"} 3000',
  'parkbench_openedge_db_metric_available{experiment_id="exp-a",run_id="run-a",variant_id="baseline",repetition="1",phase="measurement",family="buffer_pool",measurement="buffer_pool_configured_buffers",reason="available",source="_ActBuffer"} 1',
  'parkbench_openedge_db_metric_available{experiment_id="exp-a",run_id="run-a",variant_id="baseline",repetition="1",phase="measurement",family="buffer_pool",measurement="buffer_pool_logical_reads_total",reason="not_licensed",source="_ActBuffer"} 0'
);
const startup = (experiment, run, state, parameter, value, status = "recorded") => {
  const labels = `experiment_id="${experiment}",run_id="${run}",variant_id="baseline",repetition="1",phase="measurement",service="database",component="database",database_name="sports"`;
  body.push(`parkbench_openedge_db_parameter_snapshot_status{${labels},state="${state}"} 1`);
  body.push(`parkbench_openedge_db_parameter_snapshot_rows{${labels}} ${parameter ? 1 : 0}`);
  if (state !== "unavailable")
    body.push(`parkbench_openedge_db_parameter_snapshot_timestamp_seconds{${labels}} 1790590000`);
  if (parameter)
    body.push(
      `parkbench_openedge_db_parameter_snapshot_info{${labels},parameter="${parameter}",display_value="${value}",value_status="${status}"} 1`
    );
  if (parameter === "-B")
    body.push(
      `parkbench_openedge_db_parameter_snapshot_numeric{${labels},parameter="${parameter}"} ${value}`
    );
};
startup("exp-a", "run-a", "complete", "-B", "500");
startup("exp-b", "run-b", "complete", "-B", "1000");
startup("exp-a", "run-text", "complete", "-text", "plain text");
startup("exp-a", "run-empty", "empty");
startup("exp-a", "run-partial", "partial", "-B", "750");
startup("exp-a", "run-unavailable", "unavailable");

const nativeCatalog = JSON.parse(fs.readFileSync("/native-catalog.json", "utf8"));
const initialTime = Date.now();
function nativeActivity() {
  const elapsed = (Date.now() - initialTime) / 1000;
  const lines = [];
  for (const runId of ["run-a", "run-b"]) {
    const base = {
      run_id: runId,
      experiment_id: runId === "run-a" ? "exp-a" : "exp-b",
      phase: "measurement",
      service: "database",
      database_epoch: "fixture-epoch"
    };
    for (const entry of nativeCatalog.entries.filter((e) => e.sinceProtocol !== 4)) {
      if (
        entry.name === "table_operations_total" ||
        entry.name === "metric_available" ||
        entry.name === "buffer_pool_configured_buffers" ||
        entry.name === "buffer_pool_logical_reads_total"
      )
        continue;
      const labels = { ...base };
      for (const dimension of entry.dimensions)
        labels[dimension] =
          {
            pool: "primary",
            index: "actual-index",
            operation: "read",
            direction: "write",
            database_epoch: "fixture-epoch"
          }[dimension] ?? "actual-object";
      lines.push(
        `parkbench_openedge_db_${entry.name}{${Object.entries(labels)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(
            ","
          )}} ${entry.type === "counter" ? 100 + elapsed * 2 : entry.name.includes("ratio") ? 0.75 : 10}`
      );
    }
    for (const [name, type, id, naps, seconds] of [
      ["buffer", "shared", "1", 10, 2],
      ["transaction", "exclusive", "2", 30, 5],
      ["idle", "shared", "3", 0, 0]
    ]) {
      const labels = {
        ...base,
        job: "parkbench-runs",
        database: "actual-db",
        latch_name: name,
        latch_type: type,
        latch_id: id
      };
      const text = Object.entries(labels)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(",");
      for (const [measurement, rate] of [
        ["latch_named_waits_total", naps],
        ["latch_named_wait_or_spin_duration_seconds_total", seconds]
      ]) {
        lines.push(`parkbench_openedge_db_${measurement}{${text}} ${100 + (elapsed * rate) / 120}`);
        lines.push(
          `parkbench_openedge_db_metric_available{${text},family="latch",measurement="${measurement}",reason="available"} 1`
        );
      }
    }
    for (let table = 0; table < 100; table++)
      for (const operation of ["read", "create", "update", "delete", "os_read"]) {
        const labels = { ...base, table: `table-${String(table).padStart(3, "0")}`, operation };
        const rate = operation === "read" ? table + 1 : 101 - table;
        lines.push(
          `parkbench_openedge_db_table_operations_total{${Object.entries(labels)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(",")}} ${100 + elapsed * rate}`
        );
      }
  }
  return lines;
}

http
  .createServer((request, response) => {
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(`${[...body, ...nativeActivity()].join("\n")}\n`);
      return;
    }
    response.writeHead(404).end("not_found");
  })
  .listen(9100, "0.0.0.0");
