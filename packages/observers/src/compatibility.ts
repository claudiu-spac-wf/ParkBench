import fs from "node:fs";
import path from "node:path";
import { ObserverDeclaration } from "../../contracts/src/scenario";
import { OPENEDGE_DB_METRIC_CATALOG } from "../../contracts/src/openedge";
import { assertAllowedDatabaseMetric } from "./openedge-db/allowlist";

export const OBSERVER_CONTRACT_VERSIONS = {
  core: "1",
  openedge_db_v1: "1",
  openedge_pas_v1: "1",
  file_sampler_v1: "1"
} as const;

export function validateBuiltinObserverDeclaration(
  declaration: ObserverDeclaration,
  options: { allowTestHttpFallback?: boolean } = {}
): void {
  validateObserverDeclarationShape(declaration);
  assertObserverKind(declaration.kind);
  if (!(declaration.kind in OBSERVER_CONTRACT_VERSIONS)) return;
  const configuration = declaration.configuration ?? {};
  if (declaration.kind === "file_sampler_v1") {
    if (typeof configuration.path !== "string" || !configuration.path)
      throw new Error(`observer_path_required:${declaration.id}`);
  } else if (
    declaration.kind === "openedge_db_v1" &&
    typeof configuration.observerExecutable === "string" &&
    typeof configuration.observerProcedure === "string"
  ) {
    validateNativeDatabaseCommand(declaration.id, configuration);
  } else if (declaration.kind === "openedge_db_v1" && options.allowTestHttpFallback) {
    validateMetricsUrl(declaration.id, configuration);
  } else if (typeof configuration.metricsUrl !== "string" || !configuration.metricsUrl) {
    throw new Error(
      declaration.kind === "openedge_db_v1"
        ? `observer_native_command_required:${declaration.id}`
        : `observer_metrics_url_required:${declaration.id}`
    );
  } else {
    validateMetricsUrl(declaration.id, configuration);
  }
}

function validateNativeDatabaseCommand(id: string, configuration: Record<string, unknown>): void {
  const executable = String(configuration.observerExecutable ?? "");
  const procedure = String(configuration.observerProcedure ?? "");
  if (!executable || !procedure) throw new Error(`observer_native_command_required:${id}`);
  if (!/^[A-Za-z0-9_./\\:-]+$/.test(executable) || /[;&|`$\n\r]/.test(executable))
    throw new Error(`observer_executable_invalid:${id}`);
  if (
    !/\.(?:p|r)$/i.test(procedure) ||
    !/^(?:parkbench-db-observer(?:-v2)?\.(?:p|r)|prepare-run-db-observer\.p)$/i.test(path.basename(procedure))
  )
    throw new Error(`observer_procedure_not_approved:${id}`);
  if (/[\n\r]/.test(procedure)) throw new Error(`observer_procedure_invalid:${id}`);
  if (procedure.includes("/") || procedure.includes("\\")) {
    if (
      procedure === "/app/openedge/observers/db/parkbench-db-observer.p" ||
      procedure === "/app/openedge/observers/db/parkbench-db-observer.r" ||
      procedure === "/app/openedge/observers/db/parkbench-db-observer-v2.p" ||
      procedure === "/app/openedge/observers/db/parkbench-db-observer-v2.r" ||
      procedure === "/app/openedge/observers/db/prepare-run-db-observer.p"
    ) return;
    if (!fs.existsSync(procedure) || !fs.statSync(procedure).isFile())
      throw new Error(`observer_procedure_missing:${id}`);
    const source = fs.readFileSync(procedure, "utf8");
    if (/\b(CREATE|DELETE|UPDATE|INSERT)\b/i.test(source))
      throw new Error(`observer_procedure_not_read_only:${id}`);
  }
}

function validateMetricsUrl(id: string, configuration: Record<string, unknown>): void {
  if (typeof configuration.metricsUrl !== "string" || !configuration.metricsUrl)
    throw new Error(`observer_metrics_url_required:${id}`);
  try {
    const parsedUrl = new URL(configuration.metricsUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error();
  } catch {
    throw new Error(`observer_metrics_url_invalid:${id}`);
  }
}

export function validateObserverDeclarationShape(declaration: ObserverDeclaration): void {
  if (!declaration || typeof declaration !== "object")
    throw new Error("observer_declaration_required");
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(declaration.id))
    throw new Error(`observer_id_invalid:${declaration.id ?? "unknown"}`);
  if (declaration.metrics !== undefined &&
      (!Array.isArray(declaration.metrics) || declaration.metrics.length === 0))
    throw new Error(`observer_metrics_invalid:${declaration.id}`);
  if (new Set(declaration.metrics ?? []).size !== (declaration.metrics ?? []).length)
    throw new Error(`observer_metrics_duplicate:${declaration.id}`);
  if (
    (declaration.metrics ?? []).some(
      (metric) => typeof metric !== "string" || !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric)
    )
  )
    throw new Error(`observer_metric_invalid:${declaration.id}`);
  if (
    typeof declaration.samplingIntervalSeconds !== "number" ||
    !Number.isFinite(declaration.samplingIntervalSeconds) ||
    declaration.samplingIntervalSeconds <= 0
  )
    throw new Error(`observer_sampling_interval_invalid:${declaration.id}`);
  if (
    declaration.configuration !== undefined &&
    (!declaration.configuration ||
      typeof declaration.configuration !== "object" ||
      Array.isArray(declaration.configuration))
  )
    throw new Error(`observer_configuration_invalid:${declaration.id}`);
}

function toDatabaseMetric(metric: string): string {
  const knownMetrics: Record<string, string> = {
    parkbench_openedge_db_dbstatus: "_DbStatus",
    parkbench_openedge_db_actbuffer: "_ActBuffer",
    parkbench_openedge_db_userio: "_UserIO",
    parkbench_openedge_db_latch: "_Latch"
  };
  return knownMetrics[metric] ?? metric;
}

export function assertObserverKind(kind: string): void {
  if (!(kind in OBSERVER_CONTRACT_VERSIONS) && !/^[a-z][a-z0-9-]{1,63}_v[0-9]+$/.test(kind))
    throw new Error(`unsupported_observer_kind:${kind}`);
}
export function observerContractVersion(kind: string): string {
  assertObserverKind(kind);
  return (
    OBSERVER_CONTRACT_VERSIONS[kind as keyof typeof OBSERVER_CONTRACT_VERSIONS] ??
    kind.match(/_v([0-9]+)$/)?.[1] ??
    "unknown"
  );
}
