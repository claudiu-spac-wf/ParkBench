/** Frozen database storage conditions. Rates are independent per direction and device. */
export const DATABASE_IOPS_PARAMETER = "storage.databaseIopsPreset";
export const DATABASE_IOPS_LIMITS = {
  devices: 4096,
  paths: 16384,
  replyBytes: 1048576,
  evidenceBytes: 8388608,
  summaryBytes: 4096
} as const;
export const DATABASE_IOPS_FAILURE_CODES = [
  "database_iops_unsupported",
  "database_iops_device_unresolved",
  "database_iops_policy_conflict",
  "database_iops_apply_failed",
  "database_iops_unconfirmed",
  "database_iops_policy_drift"
] as const;
export type DatabaseIopsFailureCode = (typeof DATABASE_IOPS_FAILURE_CODES)[number];
export type DatabaseIopsPresetId = "hdd" | "sata-ssd" | "slow-nvme" | "fast-nvme" | "unlimited";
export interface DatabaseIopsPreset {
  id: DatabaseIopsPresetId;
  label: string;
  readIopsPerDevice: number | null;
  writeIopsPerDevice: number | null;
}
export const DATABASE_IOPS_CATALOG = freeze({
  contractVersion: "database-iops-presets.v1" as const,
  defaultPresetId: "unlimited" as const,
  presets: [
    ["hdd", "HDD", 150],
    ["sata-ssd", "SATA SSD", 90000],
    ["slow-nvme", "Slow NVME", 250000],
    ["fast-nvme", "Fast NVME", 1000000],
    ["unlimited", "Unlimited", null]
  ].map(([id, label, rate]) => ({
    id: id as DatabaseIopsPresetId,
    label: label as string,
    readIopsPerDevice: rate as number | null,
    writeIopsPerDevice: rate as number | null
  }))
});
export interface DatabaseIopsCondition {
  contractVersion: "database-iops-condition.v1";
  catalogVersion: "database-iops-presets.v1";
  presetId: DatabaseIopsPresetId;
  label: string;
  readIopsPerDevice: number | null;
  writeIopsPerDevice: number | null;
}
export interface DatabaseIopsOwner {
  daemonId: string;
  containerId: string;
  pid: number;
  startedAt: string;
  runId: string;
  composeProject: string;
  component: "database";
}
export interface DatabaseIopsDevice {
  id: string;
  path: string;
  filesystem: string;
  mountId: string;
  generation?: string;
  paths: string[];
}
export interface DatabaseIopsCoverage {
  owner: DatabaseIopsOwner;
  workingRoot: string;
  devices: DatabaseIopsDevice[];
}
/** Exact uint64 maximum is a lossless internal clearing marker, never a finite preset. */
export const DATABASE_IOPS_UNLIMITED_RATE = "18446744073709551615" as const;
export interface IopsRule {
  Path: string;
  Rate: number | typeof DATABASE_IOPS_UNLIMITED_RATE;
}
export interface IopsRules {
  read: IopsRule[];
  write: IopsRule[];
}
export interface DatabaseIopsApplicationIntent {
  contractVersion: "database-iops-application-intent.v1";
  attemptId: string;
  experimentId: string;
  runId: string;
  variantId: string;
  preparedAt: string;
  condition: DatabaseIopsCondition;
  owner: DatabaseIopsOwner;
  coverage: DatabaseIopsCoverage;
  previousIops: IopsRules;
  desiredIops: IopsRules;
}
export type PersistIopsIntent = (intent: DatabaseIopsApplicationIntent) => Promise<void>;
export type IopsStage =
  | "PREPARING"
  | "DISCOVERING"
  | "PERSISTING_INTENT"
  | "APPLYING"
  | "VERIFYING"
  | "VERIFIED"
  | "MONITORING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";
export type IopsVerificationStatus =
  "PENDING" | "MATCHED" | "NO_ADDED_CAP" | "MISMATCH" | "UNAVAILABLE";
export interface DatabaseIopsEvidence {
  contractVersion: "database-iops-evidence.v1";
  condition: DatabaseIopsCondition;
  stage: IopsStage;
  mode?: "native" | "simulated" | "none";
  applicationIntent?: DatabaseIopsApplicationIntent;
  owner?: DatabaseIopsOwner;
  coverage?: DatabaseIopsCoverage;
  capability?: {
    engineVersion?: string;
    apiVersion?: string;
    cgroupVersion?: string;
    filesystem?: string;
  };
  verification: {
    status: IopsVerificationStatus;
    checks: number;
    firstVerifiedAt?: string;
    lastVerifiedAt?: string;
    durationMs?: number;
    observed?: unknown;
  };
  appliedAt?: string;
  verifiedAt?: string;
  artifactId?: string;
  applicationOutcome?: "PENDING" | "POSSIBLY_APPLIED" | "NOT_SENT" | "VERIFIED";
  recoveryObservation?: {
    status: "MATCHED" | "MISMATCH" | "UNAVAILABLE";
    checkedAt: string;
    observed?: unknown;
    reason?: string;
  };
  failure?: {
    code: DatabaseIopsFailureCode;
    stage: string;
    phase?: string;
    reason: string;
    possiblyApplied?: boolean;
  };
  terminationDecision?: { cause: "CANCELLED" | "POLICY_DRIFT"; acceptedAt: string; phase: string };
  cleanup?: { completed: boolean; at: string };
}
export class DatabaseIopsError extends Error {
  constructor(
    readonly code: DatabaseIopsFailureCode,
    readonly evidence?: DatabaseIopsEvidence,
    reason: string = code
  ) {
    super(reason === code || reason.startsWith(`${code}:`) ? reason : `${code}:${reason}`);
    this.name = "DatabaseIopsError";
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function invalid(what: string): never {
  throw new Error(`database_iops_invalid:${what}`);
}
function record(v: any, what: string): void {
  if (!v || typeof v !== "object" || Array.isArray(v)) invalid(what);
}
function timestamp(v: any, what: string): void {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) invalid(what);
}
function id(v: any, what: string): void {
  if (typeof v !== "string" || !v || v.length > 512 || /[\x00-\x1f]/.test(v)) invalid(what);
}
export function resolveDatabaseIops(value: unknown = "unlimited"): DatabaseIopsCondition {
  const p = DATABASE_IOPS_CATALOG.presets.find((p) => p.id === value);
  if (!p) invalid("preset");
  return freeze({
    contractVersion: "database-iops-condition.v1",
    catalogVersion: DATABASE_IOPS_CATALOG.contractVersion,
    presetId: p.id,
    label: p.label,
    readIopsPerDevice: p.readIopsPerDevice,
    writeIopsPerDevice: p.writeIopsPerDevice
  });
}
export function validateDatabaseIopsCondition(value: unknown): DatabaseIopsCondition {
  record(value, "condition");
  const v = value as DatabaseIopsCondition;
  const expected = resolveDatabaseIops(v.presetId);
  if (
    Object.keys(v).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([k, x]) => v[k] !== x)
  )
    invalid("condition_revision_or_value");
  return expected;
}
export function validateDatabaseIopsOwner(v: DatabaseIopsOwner): DatabaseIopsOwner {
  record(v, "owner");
  for (const k of ["daemonId", "runId", "composeProject"]) id(v[k], `owner.${k}`);
  if (
    !/^[a-f0-9]{64}$/.test(v.containerId) ||
    !Number.isSafeInteger(v.pid) ||
    v.pid <= 0 ||
    v.component !== "database"
  )
    invalid("owner_identity");
  timestamp(v.startedAt, "owner.startedAt");
  return v;
}
export function validateDatabaseIopsCoverage(v: DatabaseIopsCoverage): DatabaseIopsCoverage {
  record(v, "coverage");
  validateDatabaseIopsOwner(v.owner);
  if (typeof v.workingRoot !== "string" || !/^\/psc\/wrk\/[a-zA-Z0-9_-]+$/.test(v.workingRoot))
    invalid("working_root");
  if (
    !Array.isArray(v.devices) ||
    !v.devices.length ||
    v.devices.length > DATABASE_IOPS_LIMITS.devices
  )
    invalid("device_capacity");
  const keys = new Set<string>();
  const devicePaths = new Set<string>();
  let paths = 0;
  for (const d of v.devices) {
    record(d, "device");
    if (!/^\d+:\d+$/.test(d.id) || d.id.startsWith("0:") || keys.has(d.id))
      invalid("device_identity");
    keys.add(d.id);
    if (
      !/^\/dev\/[a-zA-Z0-9_./-]+$/.test(d.path) ||
      d.path.split("/").includes("..") ||
      devicePaths.has(d.path)
    )
      invalid("device_path");
    devicePaths.add(d.path);
    id(d.filesystem, "filesystem");
    id(d.mountId, "mount");
    if (d.generation !== undefined) id(d.generation, "generation");
    if (!Array.isArray(d.paths) || !d.paths.length) invalid("device_paths");
    for (const p of d.paths) {
      if (
        typeof p !== "string" ||
        !(p === v.workingRoot || p.startsWith(v.workingRoot + "/")) ||
        p.split("/").some((s) => s === ".." || s === ".") ||
        /[\x00-\x1f]/.test(p)
      )
        invalid("path_escape");
      paths++;
    }
  }
  if (paths > DATABASE_IOPS_LIMITS.paths) invalid("path_capacity");
  return v;
}
export function validateIopsRules(v: IopsRules): IopsRules {
  record(v, "rules");
  if (Object.keys(v).some((k) => k !== "read" && k !== "write")) invalid("rules_fields");
  for (const a of [v.read, v.write]) {
    if (!Array.isArray(a) || a.length > DATABASE_IOPS_LIMITS.devices) invalid("rules_capacity");
    const seen = new Set<string>();
    for (const r of a) {
      if (
        !r ||
        Object.keys(r).some((k) => k !== "Path" && k !== "Rate") ||
        typeof r.Path !== "string" ||
        !/^\/dev\/[a-zA-Z0-9_./-]+$/.test(r.Path) ||
        r.Path.split("/").includes("..") ||
        (r.Rate !== DATABASE_IOPS_UNLIMITED_RATE &&
          (typeof r.Rate !== "number" || !Number.isSafeInteger(r.Rate) || r.Rate <= 0)) ||
        seen.has(r.Path)
      )
        invalid("rule");
      seen.add(r.Path);
    }
  }
  return v;
}
export function desiredIops(
  condition: DatabaseIopsCondition,
  coverage: DatabaseIopsCoverage
): IopsRules {
  return {
    read: coverage.devices.map((d) => ({
      Path: d.path,
      Rate: condition.readIopsPerDevice ?? DATABASE_IOPS_UNLIMITED_RATE
    })),
    write: coverage.devices.map((d) => ({
      Path: d.path,
      Rate: condition.writeIopsPerDevice ?? DATABASE_IOPS_UNLIMITED_RATE
    }))
  };
}
export function sameIopsRules(a: IopsRules, b: IopsRules): boolean {
  const normal = (r: IopsRule[]) => [...r].sort((x, y) => x.Path.localeCompare(y.Path));
  return (
    JSON.stringify([normal(a.read), normal(a.write)]) ===
    JSON.stringify([normal(b.read), normal(b.write)])
  );
}
export function validateDatabaseIopsIntent(
  v: DatabaseIopsApplicationIntent
): DatabaseIopsApplicationIntent {
  record(v, "intent");
  if (v.contractVersion !== "database-iops-application-intent.v1") invalid("intent_version");
  for (const k of ["attemptId", "experimentId", "runId", "variantId"]) id(v[k], k);
  timestamp(v.preparedAt, "preparedAt");
  validateDatabaseIopsCondition(v.condition);
  validateDatabaseIopsCoverage(v.coverage);
  validateDatabaseIopsOwner(v.owner);
  validateIopsRules(v.previousIops);
  validateIopsRules(v.desiredIops);
  if (
    JSON.stringify(v.owner) !== JSON.stringify(v.coverage.owner) ||
    v.runId !== v.owner.runId ||
    (!sameIopsRules(v.desiredIops, desiredIops(v.condition, v.coverage)) &&
      !(
        v.condition.presetId === "unlimited" &&
        v.desiredIops.read.length === 0 &&
        v.desiredIops.write.length === 0
      ))
  )
    invalid("intent_attribution");
  if (Buffer.byteLength(JSON.stringify(v)) > DATABASE_IOPS_LIMITS.evidenceBytes)
    invalid("intent_bytes");
  return freeze(structuredClone(v));
}
export function validateDatabaseIopsEvidence(v: DatabaseIopsEvidence): DatabaseIopsEvidence {
  record(v, "evidence");
  if (v.contractVersion !== "database-iops-evidence.v1") invalid("evidence_version");
  validateDatabaseIopsCondition(v.condition);
  if (
    ![
      "PREPARING",
      "DISCOVERING",
      "PERSISTING_INTENT",
      "APPLYING",
      "VERIFYING",
      "VERIFIED",
      "MONITORING",
      "COMPLETED",
      "FAILED",
      "CANCELLED"
    ].includes(v.stage)
  )
    invalid("stage");
  if (
    !v.verification ||
    !["PENDING", "MATCHED", "NO_ADDED_CAP", "MISMATCH", "UNAVAILABLE"].includes(
      v.verification.status
    ) ||
    !Number.isSafeInteger(v.verification.checks) ||
    v.verification.checks < 0
  )
    invalid("verification");
  if (v.coverage) validateDatabaseIopsCoverage(v.coverage);
  if (v.owner) validateDatabaseIopsOwner(v.owner);
  if (v.applicationIntent) {
    validateDatabaseIopsIntent(v.applicationIntent);
    if (JSON.stringify(v.condition) !== JSON.stringify(v.applicationIntent.condition))
      invalid("evidence_condition");
  }
  if (v.terminationDecision) {
    if (!["CANCELLED", "POLICY_DRIFT"].includes(v.terminationDecision.cause))
      invalid("termination_cause");
    timestamp(v.terminationDecision.acceptedAt, "acceptedAt");
    id(v.terminationDecision.phase, "phase");
  }
  if (
    v.applicationOutcome !== undefined &&
    !["PENDING", "POSSIBLY_APPLIED", "NOT_SENT", "VERIFIED"].includes(v.applicationOutcome)
  )
    invalid("application_outcome");
  if (v.recoveryObservation) {
    if (!["MATCHED", "MISMATCH", "UNAVAILABLE"].includes(v.recoveryObservation.status))
      invalid("recovery_observation");
    timestamp(v.recoveryObservation.checkedAt, "recovery.checkedAt");
  }
  if (
    v.failure &&
    (!DATABASE_IOPS_FAILURE_CODES.includes(v.failure.code) ||
      typeof v.failure.reason !== "string" ||
      v.failure.reason.length > 1024)
  )
    invalid("failure");
  if (Buffer.byteLength(JSON.stringify(v)) > DATABASE_IOPS_LIMITS.evidenceBytes)
    invalid("evidence_bytes");
  return v;
}
export function pendingDatabaseIops(condition: DatabaseIopsCondition): DatabaseIopsEvidence {
  return {
    contractVersion: "database-iops-evidence.v1",
    condition,
    stage: "PREPARING",
    verification: { status: "PENDING", checks: 0 }
  };
}
export function unlimitedDatabaseIops(): DatabaseIopsEvidence {
  return {
    ...pendingDatabaseIops(resolveDatabaseIops()),
    stage: "VERIFIED",
    mode: "none",
    verification: { status: "NO_ADDED_CAP", checks: 0 }
  };
}
export function acceptIopsTermination(
  e: DatabaseIopsEvidence,
  cause: "CANCELLED" | "POLICY_DRIFT",
  phase: string
): NonNullable<DatabaseIopsEvidence["terminationDecision"]> {
  return (e.terminationDecision ??= freeze({ cause, phase, acceptedAt: new Date().toISOString() }));
}
export function databaseIopsSummary(e: DatabaseIopsEvidence) {
  validateDatabaseIopsEvidence(e);
  const { observed, ...verification } = e.verification;
  const value = {
    contractVersion: e.contractVersion,
    condition: e.condition,
    stage: e.stage,
    mode: e.mode,
    verification,
    appliedAt: e.appliedAt,
    verifiedAt: e.verifiedAt,
    artifactId: e.artifactId,
    applicationOutcome: e.applicationOutcome,
    recoveryObservation: e.recoveryObservation
      ? {
          status: e.recoveryObservation.status,
          checkedAt: e.recoveryObservation.checkedAt,
          reason: e.recoveryObservation.reason
        }
      : undefined,
    deviceCount: e.coverage?.devices.length,
    pathCount: e.coverage?.devices.reduce((n, d) => n + d.paths.length, 0),
    failure: e.failure,
    terminationDecision: e.terminationDecision,
    cleanup: e.cleanup
  };
  if (Buffer.byteLength(JSON.stringify(value)) > DATABASE_IOPS_LIMITS.summaryBytes)
    invalid("summary_bytes");
  return value;
}
