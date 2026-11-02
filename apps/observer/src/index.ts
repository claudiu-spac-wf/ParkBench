import { NativeCaptureStatus } from "../../../packages/observers/src/openedge-db/native-capture-status";
import { NativeCaptureClock } from "../../../packages/observers/src/native-capture-clock";
import { createObserverHttpServer } from "../../../packages/observers/src/http-shutdown";
import { nativeMeasurementInventory } from "../../../packages/observers/src/measurement-inventory";
import {
  DiagnosticBudgetStore,
  MeasurementDiagnosticsWriter
} from "../../../packages/observers/src/measurement-diagnostics-writer";
import { validateMeasurementProducerConfig } from "../../../packages/contracts/src/measurement-diagnostics";
import { runtimeSecretValues } from "../../../packages/contracts/src/redaction";
import type { EvidenceInput } from "../../../packages/observers/src/measurement-evidence";
import type { NativeCollectionCaller } from "../../../packages/observers/src/openedge-db/collection";
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
const nativeCaptureClock = new NativeCaptureClock(
  process.env.PARKBENCH_PHASE_CLOCK_PATH,
  process.env.PARKBENCH_RUN_ID ?? ""
);
const filePath = process.env.PARKBENCH_FILE_SAMPLER_PATH;
const port = Number(process.env.PARKBENCH_METRICS_PORT ?? 9100);
const targets = (process.env.PARKBENCH_OBSERVER_TARGET_URLS ?? target ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
let diagnosticsWriter: MeasurementDiagnosticsWriter | undefined;
const diagnosticsRequested = Boolean(process.env.PARKBENCH_MEASUREMENT_DIAGNOSTICS);
const recordEvidence = diagnosticsRequested
  ? (event: EvidenceInput) => diagnosticsWriter?.record(event)
  : undefined;
const collectionTelemetry = new ObserverCollectionTelemetry(
  recordEvidence ? { diagnosticAttemptId: "producer", record: recordEvidence } : undefined
);
async function initializeEvidence() {
  if (!diagnosticsRequested) return;
  try {
    const config = validateMeasurementProducerConfig(
      JSON.parse(process.env.PARKBENCH_MEASUREMENT_DIAGNOSTICS!)
    );
    const store = await DiagnosticBudgetStore.attach(
      "/run/parkbench/measurement-diagnostics",
      config.runId,
      config.runBudgetId,
      config.config
    );
    diagnosticsWriter = await MeasurementDiagnosticsWriter.create(store, {
      ...config,
      mode: config.config.mode,
      eventLimitBytes: config.config.eventLimitBytes,
      flushIntervalMs: config.config.flushIntervalMs,
      secrets: runtimeSecretValues()
    });
    producerEvent("DIAGNOSTIC_WRITE", "STARTED", {
      startedAtMs: Date.now(),
      reasonCodes: ["producer_started"]
    });
    process.once("SIGTERM", () => {
      void stopHttp().then(async () => {
        await diagnosticsWriter?.close();
        process.exit(0);
      });
    });
  } catch {
    console.error(
      JSON.stringify({ code: "measurement_diagnostics_unavailable", component: kind ?? "observer" })
    );
  }
}
function requestCaller(request: http.IncomingMessage): NativeCollectionCaller {
  const requestId = request.headers["x-parkbench-diagnostic-request-id"];
  const floor = kind === "openedge_db_v1" ? nativeCaptureClock.minimumCapturedAtMs() : undefined;
  const sourceInterval = floor === undefined ? {} : { minimumCapturedAtMs: floor };
  return typeof requestId === "string" &&
    /^[a-zA-Z0-9_:-]{1,160}$/.test(requestId) &&
    request.headers["x-parkbench-diagnostic-caller"] === "controller"
    ? { callerRole: "CONTROLLER", requestId, ...sourceInterval }
    : { callerRole: "UNKNOWN", ...sourceInterval };
}
function producerEvent(
  stage: EvidenceInput["stage"],
  outcome: EvidenceInput["outcome"],
  fields: Partial<EvidenceInput> = {}
) {
  recordEvidence?.({
    stage,
    outcome,
    scheduledAtMs: null,
    startedAtMs: null,
    finishedAtMs: null,
    sourceCapturedAtMs: null,
    availableAtMs: null,
    timestampOrigin: "UNKNOWN",
    durationMs: 0,
    queueWaitMs: 0,
    bodyReadMs: 0,
    callerRole: "UNKNOWN",
    ...fields
  });
}
let parameterCapturePromise: Promise<OpenEdgeDbParameterCapture> | undefined;
let lastDatabaseCollectorError = "";
const nativeCaptureStatus = new NativeCaptureStatus(process.env.PARKBENCH_RUN_ID || "standalone");

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

const { server, close: stopHttp } = createObserverHttpServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname === "/native-capture-status") {
    if (kind !== "openedge_db_v1") {
      response.statusCode = 404;
      response.end("not_found");
    } else {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify(nativeCaptureStatus.snapshot()));
    }
    return;
  }
  if (requestUrl.pathname === "/native-capture-timing") {
    if (kind !== "openedge_db_v1") {
      response.statusCode = 404;
      response.end("not_found");
    } else {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify(nativeCaptureStatus.timingSnapshot()));
    }
    return;
  }
  const caller = requestCaller(request),
    requestStartedAtMs = Date.now(),
    requestMonotonicStart = performance.now();
  if (kind === "openedge_db_v1" && requestUrl.pathname === "/metrics") {
    response.once("finish", () => {
      const generation = response.getHeader("x-parkbench-collection-generation");
      const capturedAt = response.getHeader("x-parkbench-source-captured-at-ms");
      nativeCaptureStatus.exposition({
        callerRole: caller.callerRole,
        requestedAtMs: requestStartedAtMs,
        finishedAtMs: Date.now(),
        minimumCapturedAtMs: caller.minimumCapturedAtMs ?? null,
        collectionGeneration: typeof generation === "string" ? Number(generation) : null,
        sourceCapturedAtMs: typeof capturedAt === "string" ? Number(capturedAt) : null,
        httpStatus: response.statusCode
      });
    });
  }
  if (diagnosticsRequested && requestUrl.pathname === "/metrics") {
    response.once("finish", () =>
      producerEvent("EXPOSITION", response.statusCode === 200 ? "SUCCEEDED" : "FAILED", {
        callerRole: caller.callerRole,
        parentEventId: caller.requestId,
        startedAtMs: requestStartedAtMs,
        finishedAtMs: Date.now(),
        durationMs: performance.now() - requestMonotonicStart,
        reasonCodes: ["response_finished"]
      })
    );
    response.once("close", () => {
      if (!response.writableFinished)
        producerEvent("EXPOSITION", "CANCELLED", {
          callerRole: caller.callerRole,
          parentEventId: caller.requestId,
          reasonCodes: ["response_closed_before_finish"]
        });
    });
  }
  if (requestUrl.pathname === "/latch-inventory") {
    if (kind !== "openedge_db_v1") {
      response.statusCode = 404;
      response.end("not_found");
      return;
    }
    try {
      const payload = (await databaseCollector.metricsWithEvidence(caller)).payload;
      if (
        payload.protocolVersion !== 4 ||
        payload.latchInventory.runId !== process.env.PARKBENCH_RUN_ID
      )
        throw new Error("named_latch_inventory_unavailable");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          protocolVersion: 4,
          latchInventory: payload.latchInventory,
          ...(diagnosticsRequested
            ? {
                measurementInventory: nativeMeasurementInventory(
                  payload,
                  process.env.PARKBENCH_RUN_ID!
                )
              }
            : {})
        })
      );
    } catch (error) {
      response.statusCode = 503;
      response.end(kind === "openedge_db_v1" ? "native_capture_unavailable" : String(error));
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
      response.end(kind === "openedge_db_v1" ? "native_capture_unavailable" : String(error));
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
      const pathEvidence = filePath ? samplePath(filePath) : undefined;
      if (pathEvidence?.kind) response.setHeader("x-parkbench-path-kind", pathEvidence.kind);
      response.statusCode = pathEvidence?.exists ? 200 : 503;
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
      response.end(fileMetrics(filePath, response));
      return;
    }
    if (!targets.length && kind !== "openedge_db_v1") {
      response.statusCode = 503;
      response.end("observer_target_not_configured");
      return;
    }
    const startedAt = process.hrtime.bigint(),
      collectionStartedAtMs = Date.now();
    try {
      const selected = selectTargets(requestUrl);
      const body = `${await nativeMetrics(selected, requestUrl, caller, response)}${
        kind === "openedge_db_v1" && parameterCapturePromise
          ? await parameterCapturePromise.then(capturedParameterMetrics).catch(() => "")
          : ""
      }`;
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      collectionTelemetry.record(durationSeconds, "success", Date.now() / 1000, {
        startedAtMs: collectionStartedAtMs,
        finishedAtMs: Date.now(),
        monotonicDurationMs: durationSeconds * 1000
      });
      producerEvent("EXPOSITION", "SUCCEEDED", {
        callerRole: caller.callerRole,
        parentEventId: caller.requestId,
        counts: { responseBytes: Buffer.byteLength(body) },
        reasonCodes: ["body_encoded"]
      });
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; version=0.0.4");
      response.end(`${standardMetrics()}${body}`);
    } catch (error) {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      collectionTelemetry.record(durationSeconds, "failure", Date.now() / 1000, {
        startedAtMs: collectionStartedAtMs,
        finishedAtMs: Date.now(),
        monotonicDurationMs: durationSeconds * 1000
      });
      response.statusCode = 503;
      response.end(kind === "openedge_db_v1" ? "native_capture_unavailable" : String(error));
    }
    return;
  }
  response.statusCode = 404;
  response.end("not_found");
});

void initializeEvidence().then(() => server.listen(port, "0.0.0.0"));

let fileCollectionGeneration = 0;
function fileMetrics(file?: string, response?: http.ServerResponse): string {
  if (!file) return "";
  const monotonicStart = performance.now(),
    startedAtMs = Date.now(),
    generation = ++fileCollectionGeneration;
  const sample = samplePath(file);
  const capturedAtMs = Date.now();
  if (sample.kind) response?.setHeader("x-parkbench-path-kind", sample.kind);
  response?.setHeader("x-parkbench-path-captured-at-ms", String(capturedAtMs));
  producerEvent("NATIVE_CAPTURE", sample.exists ? "SUCCEEDED" : "FAILED", {
    sourceKey: "file-sampler-path",
    collectionGeneration: generation,
    startedAtMs,
    finishedAtMs: Date.now(),
    sourceCapturedAtMs: capturedAtMs,
    timestampOrigin: "SOURCE",
    durationMs: performance.now() - monotonicStart,
    counts: {
      availableMeasurements:
        Number(sample.sizeBytes !== undefined) + Number(sample.diskUsageBytes !== undefined)
    },
    reasonCodes: ["path_stat_completed"]
  });
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

async function nativeMetrics(
  values: string[],
  requestUrl?: URL,
  caller: NativeCollectionCaller = { callerRole: "UNKNOWN" },
  response?: http.ServerResponse
): Promise<string> {
  if (kind === "openedge_db_v1") {
    const captured = await databaseCollector.metricsWithEvidence(caller);
    response?.setHeader("x-parkbench-collection-id", captured.collectionId);
    response?.setHeader("x-parkbench-collection-generation", String(captured.collectionGeneration));
    if (captured.capturedAtMs !== null)
      response?.setHeader("x-parkbench-source-captured-at-ms", String(captured.capturedAtMs));
    const monotonicStart = performance.now(),
      startedAtMs = Date.now();
    const encoded = formatOpenEdgeDbMetrics(captured.payload) + "\n";
    producerEvent("PARSE", "SUCCEEDED", {
      callerRole: caller.callerRole,
      parentEventId: caller.requestId,
      collectionGeneration: captured.collectionGeneration,
      startedAtMs,
      finishedAtMs: Date.now(),
      durationMs: performance.now() - monotonicStart,
      counts: {
        returnedSamples: captured.payload.metrics.length,
        responseBytes: Buffer.byteLength(encoded)
      },
      sourceCapturedAtMs: captured.capturedAtMs,
      timestampOrigin: captured.capturedAtMs === null ? "UNKNOWN" : "SOURCE",
      reasonCodes: ["native_normalized_and_encoded"]
    });
    return encoded;
  }
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

/* The owned run clock groups requests by the declared source interval. A shared
 * real capture keeps its timestamp/generation; crossing a source or phase boundary
 * requires new evidence. Standalone scrapes retain request freshness. */
const DB_OBSERVER_REFRESH_MS = Math.max(
  1000,
  Number(process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_REFRESH_MS ?? 5000) || 5000
);
const databaseCollector = new DatabaseObserverCollection<OpenEdgeDbObserverPayload>(
  async (capture) => {
    const executable = process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE;
    const procedure = process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE;
    if (!executable || !procedure) throw new Error("openedge_db_observer_not_configured");
    const payload = await readOpenEdgeDbObserverPayload({
      executable,
      procedure,
      args: parseObserverArgs(process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_ARGS),
      onStage: (event) => {
        nativeCaptureStatus.observe(capture, event);
        producerEvent(event.stage === "PROCESS" ? "NATIVE_CAPTURE" : "PARSE", event.outcome, {
          collectionGeneration: capture.collectionGeneration,
          sourceKey: capture.sourceKey,
          callerRole: capture.caller.callerRole,
          ...(capture.caller.requestId ? { parentEventId: capture.caller.requestId } : {}),
          startedAtMs: event.startedAtMs,
          finishedAtMs: event.finishedAtMs,
          durationMs: event.durationMs,
          ...(event.responseBytes === undefined
            ? {}
            : { counts: { responseBytes: event.responseBytes } }),
          reasonCodes: [
            event.stage === "PROCESS" ? "native_process" : "native_output_normalization",
            ...(event.failure ? [event.failure.code] : [])
          ]
        });
      }
    });
    nativeCaptureStatus.captureCompleted(capture, Date.parse(payload.collectedAt));
    return payload;
  },
  DB_OBSERVER_REFRESH_MS * 2,
  Date.now,
  recordEvidence,
  (payload) => Date.parse(payload.collectedAt)
);

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
