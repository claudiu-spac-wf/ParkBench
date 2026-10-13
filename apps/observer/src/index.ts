import http from "node:http";
import { DatabaseObserverCollection } from "../../../packages/observers/src/openedge-db/collection";
import { selectPasReplicaTargets } from "../../../packages/observers/src/openedge-pas/metrics";
import { samplePath } from "../../../packages/observers/src/file-sampler";
import {
  readOpenEdgeDbObserverPayload,
  readOpenEdgeDbParameterCapture
} from "../../../packages/observers/src/openedge-db/adapter";
import { OpenEdgeDbObserverPayload } from "../../../packages/contracts/src/openedge";
import type { OpenEdgeDbParameterCapture } from "../../../packages/contracts/src/openedge-db-parameter-capture";
import { deriveDatabaseParameterSnapshot } from "../../../packages/observers/src/openedge-db/parameter-snapshot";
import { formatParameterSnapshotMetrics } from "../../../packages/observers/src/openedge-db/parameter-metrics";
import {
  PasManagementClient,
  requestWithRetry
} from "../../../packages/observers/src/openedge-pas/client";
import { formatOpenEdgePasMetrics } from "../../../packages/observers/src/openedge-pas/metrics";
import { ObserverCollectionTelemetry } from "../../../packages/observers/src/telemetry";
import { loadLocalEnvironment } from "../../../packages/contracts/src/local-env";
loadLocalEnvironment();

const target = process.env.PARKBENCH_OBSERVER_TARGET_URL;
const kind = process.env.PARKBENCH_OBSERVER_KIND;
const filePath = process.env.PARKBENCH_FILE_SAMPLER_PATH;
const port = Number(process.env.PARKBENCH_METRICS_PORT ?? 9100);
const targets = (process.env.PARKBENCH_OBSERVER_TARGET_URLS ?? target ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const collectionTelemetry = new ObserverCollectionTelemetry();
let parameterCapturePromise: Promise<OpenEdgeDbParameterCapture> | undefined;
let lastDatabaseCollectorError = "";

function cachedParameterCapture(): Promise<OpenEdgeDbParameterCapture> {
  if (!parameterCapturePromise) {
    const executable = process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE;
    const procedure = process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE;
    if (!executable || !procedure) throw new Error("openedge_db_observer_not_configured");
    parameterCapturePromise = readOpenEdgeDbParameterCapture({ executable, procedure })
      .then((capture) => {
        if (capture.status === "unavailable") parameterCapturePromise = undefined;
        return capture;
      })
      .catch((error) => {
        // A scrape may arrive while the seed is still copying. Cache successes, not failures.
        parameterCapturePromise = undefined;
        throw error;
      });
  }
  return parameterCapturePromise;
}

function capturedParameterMetrics(capture: OpenEdgeDbParameterCapture): string {
  const snapshot = deriveDatabaseParameterSnapshot(capture, {
    runId: process.env.PARKBENCH_RUN_ID ?? "unknown",
    experimentId: process.env.PARKBENCH_EXPERIMENT_ID ?? "unknown",
    variantId: process.env.PARKBENCH_VARIANT_ID ?? "unknown",
    repetition: Number(process.env.PARKBENCH_REPETITION ?? 1)
  });
  return formatParameterSnapshotMetrics(snapshot);
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname === "/latch-inventory") {
    if (kind !== "openedge_db_v1") {
      response.statusCode = 404;
      response.end("not_found");
      return;
    }
    try {
      const payload = await databaseObserverMetrics();
      if (
        payload.protocolVersion !== 4 ||
        payload.latchInventory.runId !== process.env.PARKBENCH_RUN_ID
      )
        throw new Error("named_latch_inventory_unavailable");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ protocolVersion: 4, latchInventory: payload.latchInventory }));
    } catch (error) {
      response.statusCode = 503;
      response.end(String(error));
    }
    return;
  }
  if (requestUrl.pathname === "/parameter-capture") {
    if (kind !== "openedge_db_v1") {
      response.statusCode = 404;
      response.end("not_found");
      return;
    }
    try {
      const capture = await cachedParameterCapture();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(capture));
    } catch (error) {
      response.statusCode = 503;
      response.end(String(error));
    }
    return;
  }
  if (requestUrl.pathname === "/health") {
    if (
      kind === "openedge_db_v1" &&
      (!process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE ||
        !process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE)
    ) {
      response.statusCode = 503;
      response.end("openedge_db_observer_not_configured");
      return;
    }
    if (kind === "openedge_db_v1") {
      if (process.env.PARKBENCH_OPENEDGE_DB_METRICS_ENABLED === "false") {
        response.statusCode = 200;
        response.end("ok");
        return;
      }
      response.statusCode = (await databaseObserverReady()) ? 200 : 503;
      response.end(
        response.statusCode === 200
          ? "ok"
          : lastDatabaseCollectorError.includes("openedge_db_observer_contract_invalid")
            ? "named_latch_evidence_missing:collector_contract"
            : "openedge_db_observer_unready"
      );
      return;
    }
    if (kind === "file_sampler_v1") {
      response.statusCode = filePath && samplePath(filePath).exists ? 200 : 503;
      response.end(response.statusCode === 200 ? "ok" : "file_sampler_path_unavailable");
      return;
    }
    if (!targets.length) {
      response.statusCode = 503;
      response.end("observer_target_not_configured");
      return;
    }
    response.statusCode =
      kind === "openedge_pas_v1"
        ? (await pasObserverReady(selectTargets(requestUrl)))
          ? 200
          : 503
        : (await allHealthy(selectTargets(requestUrl)))
          ? 200
          : 503;
    response.end(response.statusCode === 200 ? "ok" : "observer_target_unhealthy");
    return;
  }
  if (requestUrl.pathname === "/application-health") {
    if (!targets.length) {
      response.statusCode = 503;
      response.end("observer_target_not_configured");
      return;
    }
    const healthPath = process.env.PARKBENCH_APPLICATION_HEALTH_PATH ?? "/health";
    response.statusCode = (await allHealthy(selectTargets(requestUrl), healthPath)) ? 200 : 503;
    response.end(response.statusCode === 200 ? "ok" : "application_target_unhealthy");
    return;
  }
  if (requestUrl.pathname === "/schema-readiness") {
    if (kind !== "openedge_pas_v1" || !schemaReadinessProcedures().length) {
      response.statusCode = 503;
      response.end("database_schema_readiness_unconfigured");
      return;
    }
    const result = await validatePackagedDatabaseSchema(selectTargets(requestUrl));
    response.statusCode = result === "ready" ? 200 : result === "invalid" ? 422 : 503;
    response.end(result === "invalid" ? "database_schema_invalid" : result);
    return;
  }
  if (requestUrl.pathname === "/metrics") {
    if (
      kind === "openedge_db_v1" &&
      process.env.PARKBENCH_OPENEDGE_DB_METRICS_ENABLED === "false"
    ) {
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; version=0.0.4");
      response.end(
        `${standardMetrics()}${
          parameterCapturePromise
            ? await parameterCapturePromise.then(capturedParameterMetrics).catch(() => "")
            : ""
        }`
      );
      return;
    }
    if (kind === "file_sampler_v1") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; version=0.0.4");
      response.end(fileMetrics(filePath));
      return;
    }
    if (!targets.length && kind !== "openedge_db_v1") {
      response.statusCode = 503;
      response.end("observer_target_not_configured");
      return;
    }
    const startedAt = process.hrtime.bigint();
    try {
      const selected = selectTargets(requestUrl);
      const body = `${await nativeMetrics(selected, requestUrl)}${
        kind === "openedge_db_v1" && parameterCapturePromise
          ? await parameterCapturePromise.then(capturedParameterMetrics).catch(() => "")
          : ""
      }`;
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      collectionTelemetry.record(durationSeconds, "success");
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; version=0.0.4");
      response.end(`${standardMetrics()}${body}`);
    } catch (error) {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      collectionTelemetry.record(durationSeconds, "failure");
      response.statusCode = 503;
      response.end(String(error));
    }
    return;
  }
  response.statusCode = 404;
  response.end("not_found");
});

server.listen(port, "0.0.0.0");

function fileMetrics(file?: string): string {
  if (!file) return "";
  const sample = samplePath(file);
  if (!sample.exists) return "";
  const values = [
    sample.sizeBytes === undefined ? undefined : `parkbench_file_size_bytes ${sample.sizeBytes}`,
    sample.diskUsageBytes === undefined
      ? undefined
      : `parkbench_file_disk_usage_bytes ${sample.diskUsageBytes}`
  ];
  return `${standardMetrics()}${values.filter(Boolean).join("\n")}\n`;
}

function selectTargets(requestUrl: URL): string[] {
  const replica = Number(requestUrl.searchParams.get("replica"));
  if (kind === "openedge_pas_v1" && Number.isInteger(replica) && replica > 0)
    return targets.slice(replica - 1, replica);
  return targets;
}

async function allHealthy(values: string[], suffix = "/health"): Promise<boolean> {
  try {
    const results = await Promise.all(
      values.map((value) =>
        kind === "openedge_pas_v1"
          ? requestWithRetry(`${value}${suffix}`, 3000, process.env.PARKBENCH_CREDENTIAL_REF)
          : retryFetch(`${value}${suffix}`)
      )
    );
    return results.every((result) => result.ok);
  } catch {
    return false;
  }
}

async function pasObserverReady(values: string[]): Promise<boolean> {
  if (!(await allHealthy(values, process.env.PARKBENCH_PAS_HEALTH_PATH ?? "/health"))) return false;
  const configured = (process.env.PARKBENCH_OPENEDGE_PAS_METRICS ?? "servletRequests")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  try {
    const payloads = await Promise.all(
      values.map((value) =>
        new PasManagementClient(value, 3000, process.env.PARKBENCH_CREDENTIAL_REF).getMetrics()
      )
    );
    return configured.every((name) =>
      payloads.every((payload) => typeof payload[name] === "number")
    );
  } catch {
    return false;
  }
}

/** Workload procedures whose contract requests `validate` readiness (comma-separated). */
function schemaReadinessProcedures(): string[] {
  return (process.env.PARKBENCH_SCHEMA_READINESS_PROCEDURES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function validatePackagedDatabaseSchema(
  values: string[]
): Promise<"ready" | "invalid" | "failed" | "retry"> {
  const procedures = schemaReadinessProcedures();
  const workloadPath = process.env.PARKBENCH_WORKLOAD_PATH ?? "/work";
  if (
    !procedures.length ||
    procedures.some((procedure) => !/^Workloads\/[A-Za-z0-9_./-]+\.p$/.test(procedure))
  )
    return "failed";
  if (!["/work", "/parkbench/web/work"].includes(workloadPath)) return "failed";
  try {
    const targets = values.flatMap((value) =>
      procedures.map((procedure) => ({ value, procedure }))
    );
    const responses = await Promise.all(
      targets.map(async ({ value, procedure }) => {
        const response = await requestWithRetry(
          `${value}${workloadPath}`,
          5000,
          process.env.PARKBENCH_CREDENTIAL_REF,
          1,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ procName: procedure, input: { mode: "validate" } })
          }
        );
        let payload: any;
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }
        return { response, payload };
      })
    );
    if (responses.some(({ payload }) => payload.error === "database_schema_invalid"))
      return "invalid";
    if (responses.every(({ response, payload }) => response.ok && payload.ok === true))
      return "ready";
    if (
      responses.some(
        ({ response, payload }) =>
          (response.status >= 400 && response.status < 500) || (response.ok && payload.ok !== true)
      )
    )
      return "failed";
    return "retry";
  } catch {
    return "retry";
  }
}

async function retryFetch(url: string, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`http_${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts)
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
  throw lastError;
}

async function nativeMetrics(values: string[], requestUrl?: URL): Promise<string> {
  if (kind === "openedge_db_v1")
    return formatOpenEdgeDbMetrics(await databaseObserverMetrics()) + "\n";
  const requestedReplica = requestUrl?.searchParams.has("replica")
    ? Number(requestUrl.searchParams.get("replica"))
    : undefined;
  const selectedPas =
    kind === "openedge_pas_v1" ? selectPasReplicaTargets(targets, requestedReplica) : [];
  const responses = await Promise.all(
    values.map(async (value, index) => {
      if (kind === "openedge_pas_v1") {
        const payload = await new PasManagementClient(
          value,
          3000,
          process.env.PARKBENCH_CREDENTIAL_REF
        ).getMetrics();
        return formatOpenEdgePasMetrics(payload, selectedPas[index].replica, Date.now());
      }
      const metrics = await fetch(`${value}/metrics`, { signal: AbortSignal.timeout(3000) });
      if (!metrics.ok) throw new Error(`observer_metrics_failed:${metrics.status}`);
      return await metrics.text();
    })
  );
  return `${responses.filter(Boolean).join("\n")}\n`;
}

function standardMetrics(): string {
  return collectionTelemetry.render(kind ?? "other");
}

function formatOpenEdgeDbMetrics(payload: OpenEdgeDbObserverPayload): string {
  const rows: Array<{ name: string; type: string; labels: Record<string, string>; value: number }> =
    [];
  for (const family of payload.families) {
    for (const measurement of family.measurements) {
      rows.push({
        name: "parkbench_openedge_db_metric_available",
        type: "gauge",
        labels: {
          family: family.name,
          measurement: measurement.name,
          reason: measurement.reason,
          source: measurement.source,
          ...(measurement.labels ?? {}),
          ...(payload.protocolVersion === 4 && measurement.name.startsWith("latch_named_")
            ? { database_epoch: payload.latchInventory.databaseEpoch }
            : {})
        },
        value: measurement.availability === "available" ? 1 : 0
      });
    }
  }
  for (const metric of payload.metrics) {
    rows.push({
      name: `parkbench_openedge_db_${metric.name}`,
      type: metric.type,
      labels: { ...metric.labels, source: metric.source },
      value: metric.value
    });
  }
  if (payload.protocolVersion === 4) {
    const inventory = payload.latchInventory;
    if (inventory.runId !== process.env.PARKBENCH_RUN_ID)
      throw new Error("named_latch_inventory_owner");
    const identity = { database: inventory.database, database_epoch: inventory.databaseEpoch };
    rows.push(
      {
        name: "parkbench_openedge_db_latch_inventory_complete",
        type: "gauge",
        labels: identity,
        value: 1
      },
      {
        name: "parkbench_openedge_db_latch_inventory_instances",
        type: "gauge",
        labels: identity,
        value: inventory.instances.length
      }
    );
    for (const { availability, ...instance } of inventory.instances)
      rows.push({
        name: "parkbench_openedge_db_latch_inventory_info",
        type: "gauge",
        labels: { ...identity, ...instance },
        value: 1
      });
  }
  const typeLines = new Map<string, string>();
  for (const row of rows) typeLines.set(row.name, `# TYPE ${row.name} ${row.type}`);
  return [
    ...typeLines.values(),
    ...rows.map(({ name, labels, value }) => {
      const labelText = Object.entries(labels)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([label, labelValue]) => `${label}="${escapeLabel(labelValue)}"`)
        .join(",");
      return `${name}{${labelText}} ${value} ${Date.parse(payload.collectedAt)}`;
    })
  ].join("\n");
}

/* Metric scrapes collect a fresh native snapshot. Replaying cached explicit timestamps
 * from an independent timer can skip observations even while every scrape succeeds.
 * Health probes reuse recent evidence, and concurrent requests share one collection. */
const DB_OBSERVER_REFRESH_MS = Math.max(
  1000,
  Number(process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_REFRESH_MS ?? 5000) || 5000
);
const databaseCollector = new DatabaseObserverCollection<OpenEdgeDbObserverPayload>(async () => {
  const executable = process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE;
  const procedure = process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE;
  if (!executable || !procedure) throw new Error("openedge_db_observer_not_configured");
  return readOpenEdgeDbObserverPayload({
    executable,
    procedure,
    args: parseObserverArgs(process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_ARGS)
  });
}, DB_OBSERVER_REFRESH_MS * 2);

function databaseObserverMetrics(): Promise<OpenEdgeDbObserverPayload> {
  return databaseCollector.metrics();
}

async function databaseObserverReady(): Promise<boolean> {
  try {
    await databaseCollector.health();
    lastDatabaseCollectorError = "";
    return true;
  } catch (error) {
    lastDatabaseCollectorError = String(error).slice(0, 512);
    return false;
  }
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function parseObserverArgs(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
    throw new Error("openedge_observer_args_invalid");
  return parsed;
}
