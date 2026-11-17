import fs from "node:fs";
import path from "node:path";
import { canonicalNativeSeries } from "../../apps/control-plane/src/grafana/native-diagnostics";
import { timelineFromRun } from "../../apps/control-plane/src/grafana/run-timeline";
import {
  recordOperation,
  topLatchCategories,
  pairedBufferHits,
  appliedRunParameters
} from "../../apps/control-plane/src/reports/history-performance";
import { resolveMeasurementWindow } from "../../packages/metrics/src/measurement-window";
import { accountResourceSamples } from "../../packages/metrics/src/resource-accounting";
import { metricSeries, calculateSummaryRow } from "../../packages/metrics/src/measurement-summary";
import { RESOURCE_SUMMARY_CATALOG } from "../../packages/contracts/src/summary-catalog";

const base = process.env.PARKBENCH_REPORT_API ?? "http://127.0.0.1:13000/api/v1";
const prom = process.env.PARKBENCH_REPORT_PROMETHEUS ?? "http://127.0.0.1:19090/api/v1";
const output = path.resolve(
  process.argv[2] ?? ".parkbench/validation/feature026/history-report/data.json"
);
const finite = (value: unknown) =>
  value !== null && value !== undefined && String(value).trim() && Number.isFinite(Number(value))
    ? Number(value)
    : null;
async function get(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw Error(`${r.status}:${url.split("?")[0]}:${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function query(expression: string, time: number) {
  const r = await get(
    base +
      "/grafana/prom/api/v1/query" +
      "?" +
      new URLSearchParams({ query: expression, time: String(time) })
  );
  if (r.status !== "success") throw Error(JSON.stringify(r));
  return r.data.result;
}
// Direct Prometheus base already ends /api/v1; bridge appends that protocol path.
async function rawQuery(expression: string, time: number) {
  const r = await get(
    prom + "/query?" + new URLSearchParams({ query: expression, time: String(time) })
  );
  if (r.status !== "success") throw Error(JSON.stringify(r));
  return r.data.result;
}
async function allHistory() {
  const rows: any[] = [];
  let token: string | undefined;
  do {
    const p = await get(
      base +
        "/history/runs?" +
        new URLSearchParams({ pageSize: "100", ...(token ? { pageToken: token } : {}) })
    );
    rows.push(...p.items);
    if (p.hasMore && !p.nextPageToken) throw Error("history_cursor_missing");
    token = p.hasMore ? p.nextPageToken : undefined;
  } while (token);
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw Error("duplicate_history_run");
  return rows;
}
async function main() {
  const startedAt = new Date().toISOString(),
    history = await allHistory(),
    data = await get(base + "/experiments");
  const experiments = new Map<string, any>(
    (data.experiments ?? data.items).map((e: any) => [e.id, e])
  );
  const results: any[] = [];
  for (const h of history) {
    const detail = await get(base + "/history/runs/" + h.id),
      run = detail.run,
      e = run.environmentSnapshot ?? {},
      experiment = experiments.get(run.experimentId);
    if (!experiment) throw Error("experiment_missing:" + run.experimentId);
    const window = resolveMeasurementWindow(run),
      start = window.start ? Date.parse(window.start) / 1000 : null,
      end = window.end ? Date.parse(window.end) / 1000 : null;
    const operation = recordOperation(e.scenario),
      notes: string[] = [];
    const condition = e.databaseIopsEvidence?.condition ?? e.databaseIops;
    const row: any = {
      experiment: experiment.name,
      run: run.name ?? h.name,
      experimentId: run.experimentId,
      runId: run.id,
      revision: run.executionRevision,
      scenario: e.scenario.id,
      experimentCreatedAt: experiment.createdAt,
      cellOrdinal: h.cellOrdinal,
      repetition: run.repetition,
      state: run.state,
      validity: run.measurementValidity,
      measurementWindow: window,
      iopsPreset: condition?.label ?? "Not recorded",
      readIops: condition?.readIopsPerDevice ?? null,
      writeIops: condition?.writeIopsPerDevice ?? null,
      unlimited: condition?.presetId === "unlimited",
      latencyMs:
        e.databaseLatency?.appliedMs ??
        e.databaseLatency?.requestedMs ??
        e.effectiveConfiguration?.["network.databaseLatencyMs"] ??
        null,
      recordMetric: operation === "read" ? "Reads" : "Writes (create + update + delete)",
      records: null,
      dbCpuPercent: null,
      pasCpuPercent: null,
      bufferPrimary: null,
      bufferAlternate: null,
      latches: [],
      notes,
      source: { run: base + "/history/runs/" + run.id }
    };
    if (e.databaseIopsEvidence?.verification?.status !== "MATCHED" && !row.unlimited)
      notes.push("IOPS setup not verified");
    if (
      e.databaseLatency?.status &&
      !["verified", "not_requested", "applied"].includes(e.databaseLatency.status)
    )
      notes.push("Latency status: " + e.databaseLatency.status);
    const primary = (detail.artifacts ?? []).find((a: any) => a.kind === "db_parameter_snapshot");
    let snapshot: any;
    if (primary) {
      const url = base + "/runs/" + run.id + "/artifacts/" + primary.id;
      snapshot = await get(url);
      if (snapshot.runId !== run.id || snapshot.experimentId !== run.experimentId)
        throw Error("parameter_snapshot_owner_mismatch");
      row.source.parameterSnapshot = url;
    }
    row.parameters = appliedRunParameters(run, snapshot);
    if (row.parameters.unverified.length)
      notes.push("Configured, not captured: " + row.parameters.unverified.join(", "));
    if (start !== null && end !== null && end > start) {
      const summary = await get(base + "/runs/" + run.id + "/comparison-summary?limit=1");
      row.source.summaryStatus = summary.status;
      if (summary.status === "READY") {
        const cpu = await query(
          `parkbench_saved_summary{run_id="${run.id}",scope="resource",definition="cpu.usage",limit="500"}`,
          end
        );
        const db = cpu.find(
            (r: any) => r.metric.group === "database" && r.metric.statistic === "average"
          ),
          pas = cpu.find((r: any) => r.metric.group === "pas" && r.metric.statistic === "average");
        for (const [key, value] of [
          ["dbCpuPercent", db],
          ["pasCpuPercent", pas]
        ] as const) {
          row[key] = finite(value?.value?.[1]);
          row.source[key] = {
            status: value?.metric.status ?? "unavailable",
            missingSeconds: finite(value?.metric.missing_seconds),
            observedSeconds: finite(value?.metric.observed_seconds)
          };
          if (value?.metric.status === "partial")
            notes.push(`${key === "dbCpuPercent" ? "DB" : "PAS"} CPU partial`);
        }
      }
      const timeline = timelineFromRun(run),
        cadence = Math.max(
          timeline.nativeRefreshSeconds ?? 5,
          timeline.prometheusScrapeSeconds ?? 5
        ),
        sourceCadence = timeline.prometheusScrapeSeconds ?? 5;
      if (row.dbCpuPercent === null || row.pasCpuPercent === null) {
        const raw = await rawQuery(
          `container_cpu_usage_seconds_total{run_id="${run.id}",job="parkbench-run-owned-cadvisor",service=~"database|pas-[0-9]+"}[${Math.ceil((end - start + sourceCadence * 2) * 1000)}ms]`,
          end
        );
        for (const [key, group] of [
          ["dbCpuPercent", "database"],
          ["pasCpuPercent", "pas"]
        ] as const) {
          if (row[key] !== null) continue;
          const samples = raw
            .filter(
              (s: any) =>
                (!s.metric.execution_revision ||
                  s.metric.execution_revision === run.executionRevision) &&
                (group === "database"
                  ? s.metric.service === "database"
                  : /^pas-\d+$/.test(s.metric.service))
            )
            .flatMap((s: any) =>
              s.values.map(([t, v]: any) => ({
                metricName: "container_cpu_usage_seconds_total",
                type: "counter",
                labels: s.metric,
                timestamp: t,
                value: Number(v),
                source: s.metric.job
              }))
            );
          const accounted = accountResourceSamples(samples, { cadenceSeconds: sourceCadence }),
            series = metricSeries(accounted.samples, sourceCadence).map((s) => ({
              ...s,
              acquisitionLagSeconds: e.sourceCadences?.cadvisorHousekeepingSeconds ?? 1
            }));
          const stat = calculateSummaryRow(
            RESOURCE_SUMMARY_CATALOG.find(
              (d) => d.definitionId === "cpu.usage" && d.group === group
            )!,
            {},
            series,
            { start, end }
          ).statistics.average;
          row[key] = stat.value;
          row.source[key] = {
            status: stat.status,
            missingSeconds: stat.coverage?.missingSeconds,
            source: "retained raw CPU counters"
          };
          if (stat.status === "partial")
            notes.push(`${group === "database" ? "DB" : "PAS"} CPU partial`);
        }
      }
      const labels = `run_id="${run.id}",phase="measurement",window_start="${start * 1000}",window_end="${end * 1000}"`;
      const records = await query(
        `parkbench_db_diagnostic{${labels},metric="database_table_operations_total",view="total"}`,
        end
      );
      const selected = records.filter((r: any) =>
        operation === "read"
          ? r.metric.operation === "read"
          : ["create", "update", "delete"].includes(r.metric.operation)
      );
      const supported = selected.filter((r: any) => finite(r.value[1]) !== null);
      if (supported.length)
        row.records = supported.reduce((n: number, r: any) => n + Number(r.value[1]), 0);
      const required = operation === "read" ? ["read"] : ["create", "update", "delete"];
      row.source.records = {
        operations: required,
        coverage:
          selected.some((r: any) => r.metric.coverage_status !== "complete") ||
          !required.every((op) => supported.some((r: any) => r.metric.operation === op))
            ? "partial"
            : "complete"
      };
      if (row.source.records.coverage === "partial") notes.push("Record total partial");
      const waits = await query(
        `parkbench_db_diagnostic{${labels},metric="latch_named_waits_total",view="total",group="name_type"}`,
        end
      );
      row.latches = topLatchCategories(
        waits.map((r: any) => ({
          name: r.metric.latch_name,
          waits: finite(r.value[1]),
          coverage: r.metric.coverage_status
        }))
      );
      row.source.latchCategoriesAvailable = new Set(
        waits.filter((r: any) => finite(r.value[1]) !== null).map((r: any) => r.metric.latch_name)
      ).size;
      if (waits.some((r: any) => r.metric.coverage_status !== "complete"))
        notes.push("Latch totals/ranking partial");
      const rawBuffers = await rawQuery(
        `{__name__=~"parkbench_openedge_db_buffer_pool_(logical|os)_reads_total",run_id="${run.id}"}[${Math.ceil((end - start + cadence * 2) * 1000)}ms]`,
        end
      );
      const buffers = canonicalNativeSeries(
        rawBuffers.filter(
          (s: any) =>
            !s.metric.execution_revision || s.metric.execution_revision === run.executionRevision
        ),
        [timeline]
      );
      for (const pool of ["primary", "alternate"]) {
        const groups = new Map<string, any>();
        for (const s of buffers.filter((s) => s.metric.pool === pool)) {
          const k = JSON.stringify([s.metric.database_epoch, s.metric.database, s.metric.service]);
          const g = groups.get(k) ?? { logical: [], physical: [] };
          g[s.metric.__name__.endsWith("logical_reads_total") ? "logical" : "physical"] = s.values;
          groups.set(k, g);
        }
        const hit = pairedBufferHits([...groups.values()], start, end, cadence);
        row[pool === "primary" ? "bufferPrimary" : "bufferAlternate"] = hit;
        if (hit.coverage === "partial") notes.push(pool + " buffer hit partial");
        if (hit.ratio === null) {
          const availability = await rawQuery(
            `last_over_time(parkbench_openedge_db_metric_available{run_id="${run.id}",pool="${pool}",measurement="buffer_pool_logical_reads_total"}[${Math.ceil((end - start) * 1000)}ms])`,
            end
          );
          const disabled = availability.some(
            (r: any) => r.metric.reason === "alternate_pool_disabled"
          );

          const configured = snapshot?.rows?.find(
            (r: any) => r.name === (pool === "alternate" ? "-B2" : "-B")
          );
          hit.reason =
            disabled ||
            (configured && Number(configured.numericValue ?? configured.displayValue) === 0)
              ? "disabled"
              : hit.intervals && hit.logical === 0
                ? "no logical reads"
                : "not collected";
          if (hit.reason !== "disabled")
            notes.push(pool + " buffer hit unavailable: " + hit.reason);
        }
      }
      if (row.dbCpuPercent === null) notes.push("DB CPU unavailable");
      if (row.pasCpuPercent === null) notes.push("PAS CPU unavailable");
      if (row.records === null) notes.push("Record total unavailable");
      if (!row.latches.length) notes.push("Latch waits unavailable");
    } else notes.push("Measurement phase not reached");
    if (run.measurementValidity !== "VALID") notes.push("Run validity: " + run.measurementValidity);
    results.push(row);
    console.log(`${results.length}/${history.length} ${row.run}: ${row.state}`);
  }
  const final = await allHistory();
  if (
    JSON.stringify(final.map((r) => [r.id, r.state, r.updatedAt])) !==
    JSON.stringify(history.map((r) => [r.id, r.state, r.updatedAt]))
  )
    throw Error("history_changed_during_report");
  for (const row of results) {
    const current = (await get(base + "/history/runs/" + row.runId)).run;
    if (current.executionRevision !== row.revision)
      throw Error("execution_changed_during_report:" + row.runId);
  }
  results.sort(
    (a, b) =>
      a.experimentCreatedAt.localeCompare(b.experimentCreatedAt) ||
      a.experiment.localeCompare(b.experiment) ||
      a.cellOrdinal - b.cellOrdinal ||
      a.repetition - b.repetition
  );
  const report = {
    generatedAt: new Date().toISOString(),
    startedAt,
    experimentCount: new Set(results.map((r) => r.experimentId)).size,
    runCount: results.length,
    rows: results
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved ${results.length} runs / ${report.experimentCount} experiments`);
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
