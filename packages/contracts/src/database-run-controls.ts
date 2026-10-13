import { DATABASE_RUN_CONTROL_HELP } from "./database-run-control-help";
import type { DatabaseParameterDefinition } from "./control-ui";
import Ajv from "ajv/dist/2020";
import { loadContractSchema } from "./schema-loader";

export const DATABASE_RUN_CONTROLS_VERSION = "db-run-controls.v1" as const;
export const DATABASE_RUN_CONTROL_KEYS = {
  apwCount: "database.apwCount",
  biClusterSizeMiB: "database.biClusterSizeMiB",
  biwEnabled: "database.biwEnabled"
} as const;
export type RunControlSource = "queued" | "scenario" | "default" | "seed";
export interface DatabaseRunControls {
  contractVersion: typeof DATABASE_RUN_CONTROLS_VERSION;
  apwCount: number;
  biwEnabled: boolean;
  biCluster: { mode: "inherit" } | { mode: "override"; requestedMiB: number; nativeKiB: number };
  requested: { apwCount?: number; biwEnabled?: boolean; biClusterSizeMiB?: number };
  sources: {
    apwCount: RunControlSource;
    biwEnabled: RunControlSource;
    biClusterSizeMiB: RunControlSource;
  };
  capabilityReference: {
    version: string;
    features: string[];
    registryVersion: "run-controls-12.8.v1";
    verification: "pending_native";
    preflightEvidenceReference?: "run-context.v1.json#/requested/databaseRunControls";
  };
  requirements?: { namedLatchRequired: boolean; observerProtocolVersion: number };
}
export interface DatabaseRunControlCapabilities {
  version?: string;
  features?: readonly string[];
}
const validateRecord = new Ajv({ allErrors: true, strict: false }).compile(
  loadContractSchema("database-run-controls-v1")
);

export function validateDatabaseRunControls(input: unknown): DatabaseRunControls {
  if (!validateRecord(input))
    throw new Error(`database_run_control_invalid:record:${JSON.stringify(validateRecord.errors)}`);
  const controls = input as DatabaseRunControls;
  if (
    controls.biCluster.mode === "override" &&
    controls.biCluster.requestedMiB * 1024 !== controls.biCluster.nativeKiB
  )
    throw new Error("database_run_control_invalid:cluster_conversion_mismatch");
  for (const field of ["apwCount", "biwEnabled", "biClusterSizeMiB"] as const) {
    const requested = controls.requested[field];
    const resolved =
      field === "biClusterSizeMiB"
        ? controls.biCluster.mode === "override"
          ? controls.biCluster.requestedMiB
          : undefined
        : controls[field];
    const source = controls.sources[field];
    if (
      (requested !== undefined && requested !== resolved) ||
      (["queued", "scenario"].includes(source) && requested === undefined) ||
      (["default", "seed"].includes(source) && requested !== undefined)
    )
      throw new Error(`database_run_control_invalid:${field}:requested_source_mismatch`);
  }
  if (
    (controls.sources.apwCount === "default" && controls.apwCount !== 0) ||
    (controls.sources.biwEnabled === "default" && controls.biwEnabled !== false) ||
    (controls.sources.biClusterSizeMiB === "seed" && controls.biCluster.mode !== "inherit")
  )
    throw new Error("database_run_control_invalid:legacy_default_mismatch");
  return controls;
}

export const DATABASE_RUN_CONTROL_DEFINITIONS: DatabaseParameterDefinition[] = [
  {
    id: "param_database_apwCount",
    canonicalName: DATABASE_RUN_CONTROL_KEYS.apwCount,
    type: "integer",
    minimum: 0,
    maximum: 9,
    step: 1,
    unit: "writers",
    description: DATABASE_RUN_CONTROL_HELP[DATABASE_RUN_CONTROL_KEYS.apwCount].description,
    explanation: DATABASE_RUN_CONTROL_HELP[DATABASE_RUN_CONTROL_KEYS.apwCount].explanation,
    source: DATABASE_RUN_CONTROLS_VERSION,
    matrixAllowed: true,
    secret: false,
    definitionVersion: "1"
  },
  {
    id: "param_database_biClusterSizeMiB",
    canonicalName: DATABASE_RUN_CONTROL_KEYS.biClusterSizeMiB,
    type: "number",
    minimum: 0.015625,
    maximum: 255.984375,
    step: 0.015625,
    unit: "MiB",
    description: DATABASE_RUN_CONTROL_HELP[DATABASE_RUN_CONTROL_KEYS.biClusterSizeMiB].description,
    explanation: DATABASE_RUN_CONTROL_HELP[DATABASE_RUN_CONTROL_KEYS.biClusterSizeMiB].explanation,
    source: DATABASE_RUN_CONTROLS_VERSION,
    matrixAllowed: true,
    secret: false,
    definitionVersion: "1"
  },
  {
    id: "param_database_biwEnabled",
    canonicalName: DATABASE_RUN_CONTROL_KEYS.biwEnabled,
    type: "boolean",
    unit: "enabled/disabled",
    description: DATABASE_RUN_CONTROL_HELP[DATABASE_RUN_CONTROL_KEYS.biwEnabled].description,
    explanation: DATABASE_RUN_CONTROL_HELP[DATABASE_RUN_CONTROL_KEYS.biwEnabled].explanation,
    source: DATABASE_RUN_CONTROLS_VERSION,
    matrixAllowed: true,
    secret: false,
    definitionVersion: "1"
  }
];

export function isDatabaseRunControl(name: string): boolean {
  return Object.values(DATABASE_RUN_CONTROL_KEYS).includes(name as any);
}
export function validateDatabaseRunControl(name: string, value: unknown): void {
  let valid = false;
  if (name === DATABASE_RUN_CONTROL_KEYS.apwCount)
    valid = typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 9;
  if (name === DATABASE_RUN_CONTROL_KEYS.biwEnabled) valid = typeof value === "boolean";
  if (name === DATABASE_RUN_CONTROL_KEYS.biClusterSizeMiB) {
    const kib = typeof value === "number" ? value * 1024 : NaN;
    valid =
      Number.isFinite(kib) && Number.isInteger(kib) && kib >= 16 && kib <= 262128 && kib % 16 === 0;
  }
  if (!valid) {
    const definition = DATABASE_RUN_CONTROL_DEFINITIONS.find((d) => d.canonicalName === name);
    throw new Error(
      `database_run_control_invalid:${name}:${definition?.description ?? "unknown control"}`
    );
  }
}

export function resolveDatabaseRunControls(
  scenarioValues: Record<string, unknown> = {},
  queuedValues: Record<string, unknown> = {},
  capabilities: DatabaseRunControlCapabilities = {},
  secondQueuedAssignment: Record<string, unknown> = {}
): DatabaseRunControls {
  const requested: DatabaseRunControls["requested"] = {};
  const sources: DatabaseRunControls["sources"] = {
    apwCount: "default",
    biwEnabled: "default",
    biClusterSizeMiB: "seed"
  };
  const values: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(DATABASE_RUN_CONTROL_KEYS)) {
    if (
      queuedValues[key] !== undefined &&
      secondQueuedAssignment[key] !== undefined &&
      queuedValues[key] !== secondQueuedAssignment[key]
    )
      throw new Error(`database_run_control_invalid:${key}:duplicate_queued_assignment`);
    const queued =
      queuedValues[key] !== undefined ? queuedValues[key] : secondQueuedAssignment[key];
    const value = queued !== undefined ? queued : scenarioValues[key];
    if (value === undefined) continue;
    validateDatabaseRunControl(key, value);
    values[field] = value;
    (requested as Record<string, unknown>)[field] = value;
    sources[field as keyof typeof sources] = queued !== undefined ? "queued" : "scenario";
  }
  const cluster = values.biClusterSizeMiB as number | undefined;
  const controls: DatabaseRunControls = {
    contractVersion: DATABASE_RUN_CONTROLS_VERSION,
    apwCount: (values.apwCount as number | undefined) ?? 0,
    biwEnabled: (values.biwEnabled as boolean | undefined) ?? false,
    biCluster:
      cluster === undefined
        ? { mode: "inherit" }
        : { mode: "override", requestedMiB: cluster, nativeKiB: cluster * 1024 },
    requested,
    sources,
    capabilityReference: {
      version: capabilities.version ?? "unverified",
      features: [...(capabilities.features ?? [])],
      registryVersion: "run-controls-12.8.v1",
      verification: "pending_native",
      preflightEvidenceReference: "run-context.v1.json#/requested/databaseRunControls"
    }
  };
  if (
    (controls.apwCount > 0 || controls.biwEnabled || cluster !== undefined) &&
    capabilities.version &&
    !/^12\.8(?:\.|$)/.test(capabilities.version)
  )
    throw new Error("database_run_control_invalid:openedge_version_unverified:requires_12.8");
  if (
    (controls.apwCount > 0 || controls.biwEnabled) &&
    capabilities.version &&
    !capabilities.features?.includes("enterprise")
  )
    throw new Error(
      "database_writer_unavailable:enterprise_required: APW/BIW capability is not configured. " +
        "Set PARKBENCH_OPENEDGE_DB_FEATURES=enterprise for a verified Enterprise database and restart the control plane."
    );
  return validateDatabaseRunControls(controls);
}

/** Legacy runtime records do not acquire newly required writers or measurement policy. */
export function legacyDatabaseRunControls(): DatabaseRunControls {
  return resolveDatabaseRunControls();
}

export function validateWriterCapacity(
  controls: DatabaseRunControls,
  capacity: number,
  existingConnections: number
): void {
  const required = existingConnections + controls.apwCount + Number(controls.biwEnabled);
  if (
    !Number.isInteger(capacity) ||
    !Number.isInteger(existingConnections) ||
    capacity < required ||
    existingConnections < 1
  )
    throw new Error(
      `database_writer_capacity_insufficient:required=${required}:available=${capacity}`
    );
}
