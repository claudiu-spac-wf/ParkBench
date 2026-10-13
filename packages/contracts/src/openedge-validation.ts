import {
  OPENEDGE_WORKLOAD_BODY_LIMIT_BYTES,
  OPENEDGE_WORKLOAD_TIMEOUT_MS,
  JsonValue,
  WorkErrorAcknowledgement,
  WorkRequest
} from "./openedge";
import { BenchmarkImageManifest, OPENEDGE_CONTRACT_VERSION } from "./openedge";
import { DATABASE_NAME_PATTERN, SEED_NAME_PATTERN } from "./seed";
import { OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION } from "./openedge";
import { parseImageReference } from "./image-reference";
import { OPENEDGE_DB_PARAMETER_CAPTURE_VERSION } from "./openedge-db-parameter-capture";
import { validateOperationTemplateValues } from "./scenario";

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 100) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).every(
    ([key, item]) => key.length > 0 && isJsonValue(item, depth + 1)
  );
}

export function validateCanonicalProcName(procName: unknown): string {
  if (typeof procName !== "string") throw new Error("unsafe_proc_name");
  if (
    !procName ||
    procName.length > 512 ||
    procName.includes("\\") ||
    procName.includes("%") ||
    procName.includes(":") ||
    procName.startsWith("/") ||
    procName.endsWith("/") ||
    procName.includes("//")
  )
    throw new Error("unsafe_proc_name");
  const parts = procName.split("/");
  if (parts.length < 2 || parts[0] !== "Workloads" || parts.some((part) => !part))
    throw new Error("unsafe_proc_name");
  if (parts.some((part) => part === "." || part === "..")) throw new Error("unsafe_proc_name");
  if (!parts.every((part) => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(part)))
    throw new Error("unsafe_proc_name");
  if (!/\.p$/.test(parts[parts.length - 1])) throw new Error("unsafe_proc_name");
  return procName;
}

/** Distinct procedures called through `POST /work` by a scenario's operations. */
export function workProcedureNames(scenario: any): string[] {
  const operations = Array.isArray(scenario?.workload?.operations)
    ? scenario.workload.operations
    : [];
  return [
    ...new Set<string>(
      operations
        .filter((operation: any) => operation?.method === "POST" && operation?.path === "/work")
        .map((operation: any) => operation?.bodyTemplate?.procName)
    )
  ];
}

/**
 * Generic validation for any scenario that calls PAS `POST /work` (feature 014): every
 * procedure is canonical, packaged, compiled, carried by the PAS image and has a workload
 * contract. There are no rules on scenario id, operation count or measurement length.
 */
export function validateWorkScenario(scenario: any, manifest?: BenchmarkImageManifest): void {
  const operations = Array.isArray(scenario?.workload?.operations)
    ? scenario.workload.operations
    : [];
  const workOperations = operations.filter(
    (operation: any) => operation?.method === "POST" && operation?.path === "/work"
  );
  if (!workOperations.length) return;
  const fail = (rule: string): never => {
    throw new Error(`work_scenario_invalid:${rule}`);
  };
  if (!(scenario.phases?.warmupSeconds > 0)) fail("warmup");
  if (!(scenario.phases?.cooldownSeconds > 0)) fail("cooldown");
  for (const operation of workOperations) {
    try {
      validateCanonicalProcName(operation.bodyTemplate?.procName);
    } catch {
      fail(`procName:${operation.id}`);
    }
    const input = operation.bodyTemplate?.input;
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail(`input_mode:${operation.id}`);
    if (operation.bodyTemplate.procName.startsWith("Workloads/Write/")) {
      if (!["create", "update"].includes(input.Operation)) fail(`input_operation:${operation.id}`);
    } else if (typeof input.mode !== "string") fail(`input_mode:${operation.id}`);
    if (!Array.isArray(operation.expectedStatus) || !operation.expectedStatus.includes(200))
      fail(`expectedStatus:${operation.id}`);
  }
  for (const operation of operations) validateOperationTemplateValues(operation);
  if (!manifest) return;
  for (const procName of workProcedureNames(scenario)) {
    const workload = manifest.workloads?.find((candidate) => candidate.procName === procName);
    if (!workload) fail(`procedure_missing:${procName}`);
    if (workload.compiled !== true) fail(`procedure_uncompiled:${procName}`);
    if (workload.imageReference !== manifest.pasoe.reference) fail(`procedure_image:${procName}`);
    if (!workload.contract?.path) fail(`procedure_contract:${procName}`);
  }
}

export function serializeWorkloadInput(input: unknown): string {
  if (!isJsonValue(input)) throw new Error("invalid_work_request");
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new Error("invalid_work_request");
  return serialized;
}

export function parseWorkRequestBody(body: string | Buffer): WorkRequest {
  if (Buffer.byteLength(body) > OPENEDGE_WORKLOAD_BODY_LIMIT_BYTES)
    throw new Error("invalid_work_request");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString());
  } catch {
    throw new Error("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_work_request");
  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "procName") || !("input" in record))
    throw new Error("invalid_work_request");
  if (Object.keys(record).some((key) => !["procName", "input"].includes(key)))
    throw new Error("invalid_work_request");
  const procName = validateCanonicalProcName(record.procName);
  if (!isJsonValue(record.input)) throw new Error("invalid_work_request");
  serializeWorkloadInput(record.input);
  return { procName, input: record.input };
}

export function classifyTimeout(elapsedMs = OPENEDGE_WORKLOAD_TIMEOUT_MS): {
  status: "timed_out";
  timeoutMs: typeof OPENEDGE_WORKLOAD_TIMEOUT_MS;
  elapsedMs: number;
  latencyObservation: "lower_bound";
  errorCode: "workload_timeout";
} {
  return {
    status: "timed_out",
    timeoutMs: OPENEDGE_WORKLOAD_TIMEOUT_MS,
    elapsedMs: Math.max(OPENEDGE_WORKLOAD_TIMEOUT_MS, Math.round(elapsedMs)),
    latencyObservation: "lower_bound",
    errorCode: "workload_timeout"
  };
}

export function boundedWorkError(
  error: unknown,
  requestId: string,
  elapsedMs?: number
): WorkErrorAcknowledgement {
  const code = String(error)
    .replace(/^Error:\s*/, "")
    .split(":", 1)[0];
  const allowed = new Set<WorkErrorAcknowledgement["error"]>([
    "invalid_json",
    "invalid_work_request",
    "unsafe_proc_name",
    "workload_not_found",
    "workload_timeout",
    "database_schema_invalid",
    "workload_failed"
  ]);
  return {
    ok: false,
    error: allowed.has(code as WorkErrorAcknowledgement["error"])
      ? (code as WorkErrorAcknowledgement["error"])
      : elapsedMs !== undefined && elapsedMs >= OPENEDGE_WORKLOAD_TIMEOUT_MS
        ? "workload_timeout"
        : "workload_failed",
    requestId
  };
}

export function isWorkloadTimeout(error: unknown): boolean {
  return String(error).includes("workload_timeout") || String(error).includes("AbortError");
}

export function isExplicitTaggedImageReference(value: unknown): value is string {
  try {
    parseImageReference(value);
    return true;
  } catch {
    return false;
  }
}

export function validateBenchmarkImageManifest(
  input: unknown,
  finalOnly = false
): BenchmarkImageManifest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("openedge_image_manifest_invalid");
  const manifest = input as Record<string, any>;
  if (manifest.schemaVersion === "image-build.v1")
    throw new Error("openedge_manifest_rebuild_required");
  if (manifest.schemaVersion !== OPENEDGE_CONTRACT_VERSION)
    throw new Error("openedge_manifest_version_invalid");
  if (!["generic", "final"].includes(manifest.imageStage))
    throw new Error("openedge_manifest_stage_invalid");
  if (manifest.parkBenchReady !== (manifest.imageStage === "final"))
    throw new Error("openedge_manifest_readiness_invalid");
  if (finalOnly && (manifest.imageStage !== "final" || manifest.parkBenchReady !== true))
    throw new Error("final_openedge_manifest_required");
  for (const key of ["db", "pasoe", "observer", "jdk"])
    if (!isExplicitTaggedImageReference(manifest[key]?.reference))
      throw new Error(`openedge_manifest_${key}_image_invalid`);
  if (
    ![2, 3, OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION].includes(
      manifest.observerContract?.protocolVersion
    ) ||
    manifest.observerContract.parameterCaptureVersion !== OPENEDGE_DB_PARAMETER_CAPTURE_VERSION
  )
    throw new Error("openedge_manifest_observer_contract_invalid");
  if (
    finalOnly &&
    manifest.observerContract.protocolVersion !== OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION
  )
    throw new Error("openedge_observer_all_table_rebuild_required");
  if (
    manifest.observerContract.protocolVersion >= 3 &&
    manifest.observerContract.tableCoverage !== "all_tables"
  )
    throw new Error("openedge_manifest_observer_contract_invalid");
  if (finalOnly) {
    if (
      !Array.isArray(manifest.workloads) ||
      manifest.workloads.length === 0 ||
      manifest.workloads.some(
        (workload: any) => typeof workload?.procName !== "string" || workload.compiled !== true
      )
    )
      throw new Error("openedge_manifest_workloads_invalid");
    if (
      manifest.workloads.some(
        (workload: any) =>
          workload.contract !== undefined &&
          (typeof workload.contract?.path !== "string" ||
            !workload.contract.path.startsWith("Workloads/") ||
            !workload.contract.path.endsWith(".contract.json"))
      )
    )
      throw new Error("openedge_manifest_workload_contract_invalid");
    const schema = manifest.compileSchema;
    if (
      !schema ||
      typeof schema.seed !== "string" ||
      !SEED_NAME_PATTERN.test(schema.seed) ||
      schema.databaseName !== manifest.databaseName ||
      (schema.schemaSha256 !== undefined && !/^[a-f0-9]{64}$/.test(schema.schemaSha256))
    )
      throw new Error("openedge_manifest_compile_schema_invalid");
  }
  for (const key of [
    "buildDurationMs",
    ...(manifest.imageStage === "final" ? ["totalBuildDurationMs"] : [])
  ])
    if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0)
      throw new Error(`openedge_manifest_${key}_invalid`);
  if (
    typeof manifest.databaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(manifest.databaseName)
  )
    throw new Error("openedge_manifest_database_invalid");
  if (typeof manifest.runnerArchive?.path !== "string")
    throw new Error("openedge_manifest_archive_invalid");
  return manifest as BenchmarkImageManifest;
}
