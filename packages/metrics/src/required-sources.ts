import type { MetricSample } from "../../contracts/src/metrics";
import type { Run } from "../../contracts/src/run";
import type { MeasurementWindow } from "../../contracts/src/run-summary";
import type { PrometheusClient } from "./prometheus-client";
import { readRawChunks, RawQueryOptions } from "./raw-query";

export interface SourceVerification {
  selector: string;
  start: number;
  end: number;
  purpose: "required_source_verification";
  metricName: string;
  observed: boolean;
  labelKeys: string[];
  reason?: string;
}
export function finalizationQueryOptions(run: Run): RawQueryOptions {
  const env = (run.environmentSnapshot ??= {});
  const verification = (env.requiredSourceVerification ??= {
    startedAt: Date.now(),
    queries: []
  }) as any;
  return {
    priority: "finalization",
    signal: AbortSignal.timeout(Math.max(1, 120000 - (Date.now() - verification.startedAt)))
  };
}
export function recordVerificationQuery(run: Run, query: Record<string, unknown>) {
  const verification = ((run.environmentSnapshot ??= {}).requiredSourceVerification ??= {
    startedAt: Date.now(),
    queries: []
  }) as any;
  verification.queries.push(query);
  if (Buffer.byteLength(JSON.stringify(verification), "utf8") > 1024 * 1024)
    throw new Error("summary_limit_exceeded:verification_metadata");
}

/** Required families are independent of a scenario's additional measurement list. */
export async function verifyRequiredSources(
  client: PrometheusClient,
  run: Run,
  window: MeasurementWindow,
  cadence: number,
  options: RawQueryOptions = {}
) {
  const gaps: NonNullable<Run["completeness"]>["requiredGaps"] = [];
  const queries: SourceVerification[] = [];
  const optionalWarnings: string[] = [];
  if (!window.start || !window.end || window.durationSeconds <= 0)
    return { gaps, queries, optionalWarnings };
  const start = Date.parse(window.start) / 1000,
    end = Date.parse(window.end) / 1000;
  const env = (run.environmentSnapshot as any) ?? {};
  const id = JSON.stringify(run.id);
  const continuous = env.metricsCollectionMode === "continuous";
  const phaseFilter = continuous ? "" : ',phase="measurement"';
  const checks: Array<{ metric: string; labels?: string; family: string }> = [];
  const add = (family: string, metrics: string[], labels = `run_id=${id}${phaseFilter}`) => {
    for (const metric of metrics) checks.push({ metric, labels, family });
  };
  add(
    "workload",
    [
      "parkbench_workload_requests_total",
      "parkbench_workload_request_duration_seconds_bucket",
      "parkbench_workload_request_duration_seconds_count",
      "parkbench_workload_request_duration_seconds_sum"
    ],
    `run_id=${id},phase="measurement"`
  );
  const replicas = Number(env.scenario?.target?.pasReplicas ?? 1);
  for (let n = 1; n <= replicas; n++)
    add(
      `pas-${n}`,
      ["parkbench_openedge_pas_requests_total"],
      `run_id=${id}${phaseFilter},replica="pas-${n}"`
    );
  if (env.effectiveConfiguration?.["database.metricsEnabled"] === false)
    optionalWarnings.push("native_database:not_configured:source_disabled");
  else add("native_database", ["parkbench_openedge_db_database_table_operations_total"]);
  add("host", [
    "node_cpu_seconds_total",
    "node_memory_MemAvailable_bytes",
    "node_disk_read_bytes_total",
    "node_disk_written_bytes_total"
  ]);
  for (const service of ["database", ...Array.from({ length: replicas }, (_, i) => `pas-${i + 1}`)])
    add(
      service,
      [
        "container_cpu_usage_seconds_total",
        "container_memory_working_set_bytes",
        "container_fs_reads_bytes_total",
        "container_fs_writes_bytes_total"
      ],
      `job="parkbench-run-owned-cadvisor",run_id=${id},service=${JSON.stringify(service)}`
    );
  // The configured sampler may observe a directory, which has allocation but no file-size gauge.
  add("files", ["parkbench_file_disk_usage_bytes"]);
  for (const check of checks) {
    const selector = `${check.metric}{${check.labels}}`;
    let observed = false,
      reason = "required_series_missing";
    try {
      for await (const chunk of readRawChunks(client, selector, start, end, cadence, options)) {
        const sample = chunk.samples.find((s) => Number.isFinite(s.value));
        queries.push({
          selector: chunk.query,
          start: chunk.start,
          end: chunk.end,
          purpose: "required_source_verification",
          metricName: check.metric,
          observed: !!sample,
          labelKeys: sample ? Object.keys(sample.labels).sort() : []
        });
        if (sample) {
          observed = true;
          break;
        }
      }
    } catch (error) {
      reason = String(error).includes("summary_limit_exceeded")
        ? "summary_limit_exceeded"
        : String(error).includes("query_timeout") || String(error).includes("TimeoutError")
          ? "query_timeout"
          : "source_unavailable";
      queries.push({
        selector,
        start,
        end,
        purpose: "required_source_verification",
        metricName: check.metric,
        observed: false,
        labelKeys: [],
        reason
      });
    }
    if (!observed)
      gaps.push({
        observerId: `required-source:${check.family}`,
        phase: "measurement",
        metricName: check.metric,
        measurementId: selector,
        source: "prometheus",
        expected: 1,
        observed: 0,
        missing: 1,
        availability: "not_collected",
        availabilityReason: reason
      });
  }
  await verifyNamedLatches(client, run, start, end, cadence, options, gaps, queries);
  return { gaps, queries, optionalWarnings };
}

/** Validate every authoritative acquisition against its complete native inventory. */
async function verifyNamedLatches(
  client: PrometheusClient,
  run: Run,
  start: number,
  end: number,
  cadence: number,
  options: RawQueryOptions,
  gaps: NonNullable<Run["completeness"]>["requiredGaps"],
  queries: SourceVerification[]
) {
  const env = run.environmentSnapshot as any;
  if (!env?.databaseRunControls?.requirements?.namedLatchRequired) return;
  const prefix = "parkbench_openedge_db_";
  const gap = (
    reason: string,
    identity = "inventory",
    metric = "latch_named_waits_total",
    expected = 1,
    observed = 0
  ) => {
    if (
      gaps.some(
        (g) =>
          g.observerId === "required-source:named-latch" &&
          g.measurementId === identity &&
          g.availabilityReason === reason
      )
    )
      return;
    gaps.push({
      observerId: "required-source:named-latch",
      phase: "measurement",
      metricName: prefix + metric,
      measurementId: identity,
      source: "prometheus",
      expected,
      observed,
      missing: Math.max(1, expected - observed),
      availability: "not_collected",
      availabilityReason: reason
    });
  };
  const inventories = env.namedLatchInventories;
  if (
    !Array.isArray(inventories) ||
    !inventories.length ||
    inventories.some(
      (i: any) =>
        i.runId !== run.id ||
        i.authoritativePublisher !== "endpoint" ||
        i.complete !== true ||
        !i.database ||
        !i.databaseEpoch ||
        !Number.isFinite(Date.parse(i.capturedAt)) ||
        !Array.isArray(i.instances) ||
        !i.instances.length ||
        i.instances.length > 512 ||
        i.instances.some((t: any) =>
          [t.latch_name, t.latch_type, t.latch_id].some(
            (v) => typeof v !== "string" || !v.trim() || v.length > 256
          )
        )
    )
  ) {
    gap("inventory_missing_or_invalid");
    return;
  }
  const names = [
    "latch_inventory_complete",
    "latch_inventory_instances",
    "latch_inventory_info",
    "latch_named_waits_total",
    "latch_named_wait_or_spin_duration_seconds_total",
    "metric_available"
  ];
  const batches = new Map<string, MetricSample[]>();
  let sourceFailed = false;
  for (const name of names) {
    const metricName = prefix + name;
    const selector = `${metricName}{run_id=${JSON.stringify(run.id)},job="parkbench-runs"${name === "metric_available" ? ',family="latch"' : ""}}`;
    const samples: MetricSample[] = [];
    try {
      for await (const chunk of readRawChunks(client, selector, start, end, cadence, options)) {
        samples.push(
          ...chunk.samples.filter(
            (s) =>
              s.labels.run_id === run.id &&
              s.labels.job === "parkbench-runs" &&
              s.timestamp >= start &&
              s.timestamp < end
          )
        );
        queries.push({
          selector: chunk.query,
          start: chunk.start,
          end: chunk.end,
          purpose: "required_source_verification",
          metricName,
          observed: chunk.samples.length > 0,
          labelKeys: [...new Set(chunk.samples.flatMap((s) => Object.keys(s.labels)))].sort()
        });
        if (samples.length > 1_000_000) throw new Error("summary_limit_exceeded:named_latches");
      }
    } catch (error) {
      sourceFailed = true;
      const reason = String(error).includes("summary_limit_exceeded")
        ? "summary_limit_exceeded"
        : "source_unavailable";
      gap(reason, "inventory", name);
      queries.push({
        selector,
        start,
        end,
        purpose: "required_source_verification",
        metricName,
        observed: false,
        labelKeys: [],
        reason
      });
    }
    batches.set(name, samples);
  }
  if (sourceFailed) return;
  const get = (name: string) => batches.get(name)!;
  const captureKey = (s: MetricSample) =>
    JSON.stringify([s.labels.database, s.labels.database_epoch, s.timestamp]);
  const captures = new Map<string, MetricSample>();
  for (const sample of get("latch_inventory_complete")) {
    if (sample.value !== 1) {
      gap("inventory_incomplete");
      continue;
    }
    captures.set(captureKey(sample), sample);
  }
  const times = [...new Set([...captures.values()].map((s) => s.timestamp))].sort((a, b) => a - b);
  if (
    times.length < Math.min(2, Math.ceil((end - start) / cadence)) ||
    times[0] - start > cadence * 1.5 ||
    end - times[times.length - 1] > cadence * 1.5 ||
    times.some((t, i) => i > 0 && t - times[i - 1] > cadence * 1.5)
  )
    gap(
      "acquisition_coverage_missing",
      "inventory",
      "latch_inventory_complete",
      Math.max(1, Math.ceil((end - start) / cadence)),
      times.length
    );
  const tupleKey = (t: Record<string, any>) =>
    JSON.stringify([t.latch_name, t.latch_type, t.latch_id]);
  const byCapture = new Map<string, Map<string, MetricSample[]>>();
  const byTuple = new Map<string, MetricSample[]>();
  for (const name of names) {
    const map = new Map<string, MetricSample[]>();
    for (const sample of get(name)) {
      const key = captureKey(sample);
      const rows = map.get(key) ?? [];
      rows.push(sample);
      map.set(key, rows);
      const identity = JSON.stringify([
        name,
        key,
        tupleKey(sample.labels),
        name === "metric_available" ? sample.labels.measurement : ""
      ]);
      const tupleRows = byTuple.get(identity) ?? [];
      tupleRows.push(sample);
      byTuple.set(identity, tupleRows);
    }
    byCapture.set(name, map);
  }
  const captureRows = (name: string, key: string) => byCapture.get(name)?.get(key) ?? [];
  const tupleRows = (name: string, key: string, tuple: any, measurement = "") =>
    byTuple.get(JSON.stringify([name, key, tupleKey(tuple), measurement])) ?? [];
  for (const [key, capture] of captures) {
    const earlier = inventories
      .filter(
        (i: any) =>
          Date.parse(i.capturedAt) / 1000 <= capture.timestamp &&
          i.database === capture.labels.database &&
          i.databaseEpoch === capture.labels.database_epoch
      )
      .sort((a: any, b: any) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0];
    if (!earlier) {
      gap("inventory_owner_mismatch", key);
      continue;
    }
    const infos = captureRows("latch_inventory_info", key).filter((s) => s.value === 1);
    const declared = captureRows("latch_inventory_instances", key);
    const ids = new Set(infos.map((s) => s.labels.latch_id));
    if (
      declared.length !== 1 ||
      !Number.isSafeInteger(declared[0]?.value) ||
      declared[0]?.value !== infos.length ||
      !infos.length ||
      infos.length > 512 ||
      ids.size !== infos.length
    ) {
      gap("inventory_count_mismatch", key);
      continue;
    }
    const present = new Set(infos.map((s) => tupleKey(s.labels)));
    for (const tuple of earlier.instances)
      if (!present.has(tupleKey(tuple)))
        gap("inventory_tuple_missing", `${key}:${tupleKey(tuple)}`, "latch_inventory_info");
    const instances = infos.map((s) => ({
      latch_name: s.labels.latch_name,
      latch_type: s.labels.latch_type,
      latch_id: s.labels.latch_id,
      availability: "available"
    }));
    if (
      instances.some((t) =>
        [t.latch_name, t.latch_type, t.latch_id].some((v) => !v || !v.trim() || v.length > 256)
      )
    ) {
      gap("inventory_identity_invalid", key);
      continue;
    }
    if (
      JSON.stringify(instances.map(tupleKey).sort()) !==
      JSON.stringify(earlier.instances.map(tupleKey).sort())
    ) {
      const next = {
        runId: run.id,
        database: capture.labels.database,
        databaseEpoch: capture.labels.database_epoch,
        capturedAt: new Date(capture.timestamp * 1000).toISOString(),
        authoritativePublisher: "endpoint",
        complete: true,
        instances
      };
      if (
        !inventories.some(
          (i: any) => i.capturedAt === next.capturedAt && i.databaseEpoch === next.databaseEpoch
        )
      )
        inventories.push(next);
    }
    for (const tuple of instances) {
      const identity = `${key}:${tupleKey(tuple)}`;
      for (const name of [
        "latch_named_waits_total",
        "latch_named_wait_or_spin_duration_seconds_total"
      ]) {
        const availability = tupleRows("metric_available", key, tuple, name);
        const metrics = tupleRows(name, key, tuple);
        const unsupported =
          name !== "latch_named_waits_total" &&
          availability.length === 1 &&
          availability[0].value === 0 &&
          ["field_missing", "vst_missing"].includes(availability[0].labels.reason);
        if (unsupported && !metrics.length) continue;
        if (
          availability.length !== 1 ||
          availability[0].value !== 1 ||
          availability[0].labels.reason !== "available" ||
          metrics.length !== 1 ||
          !Number.isFinite(metrics[0].value) ||
          metrics[0].value < 0 ||
          (name === "latch_named_waits_total" && !Number.isSafeInteger(metrics[0].value))
        )
          gap("named_tuple_sample_or_availability_missing", identity, name);
      }
    }
  }
}
