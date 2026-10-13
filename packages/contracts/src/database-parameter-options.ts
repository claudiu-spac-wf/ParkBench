import registry from "./database-startup-parameter-catalog.json";
export const DATABASE_PARAMETER_OPTIONS_VERSION = "database-parameter-options.v2" as const;
/** Audited 12.8 metadata, with explicit source and platform constraints. */
export const DATABASE_PARAMETER_REGISTRY_VERSION = "openedge-startup-catalog.12.8.v1" as const;
export type DatabaseParameterValueKind =
  "integer" | "decimal" | "string" | "enum" | "presence_flag" | "valued_boolean";
export type ParameterBound =
  | { status: "documented"; value: number | string | boolean; condition?: string }
  | { status: "not_specified" }
  | { status: "not_applicable" };
export interface AuditedDatabaseParameter {
  name: string;
  sourceNames: string[];
  aliases: string[];
  description: string;
  /** Operator explanation; absent only on retained older options. */
  explanation?: string;
  auditStatus: "audited";
  documentation: Array<{ url: string; version: string }>;
  documentationVersion: string;
  scope:
    | "primary_database_broker"
    | "database_client"
    | "database_utility"
    | "secondary_broker"
    | "adminserver"
    | "interactive_database"
    | "sql_server";
  valueKind: DatabaseParameterValueKind;
  argumentForm: "presence" | "one_value" | "multiple_values";
  argumentCount: number;
  unit?: string;
  multiUser: { minimum: ParameterBound; maximum: ParameterBound; default: ParameterBound };
  allowedValues?: Array<string | number>;
  increment?: number;
  enumCase?: "sensitive" | "insensitive";
  requiredFeatures: string[];
  platforms: string[];
  minimumVersion: string;
  dependencies: Array<{
    name: string;
    values?: Array<string | number | boolean>;
    condition: string;
  }>;
  conditions: string[];
  ownership: {
    rule: "scalar" | "owned_path" | "managed_infrastructure" | "controlled_input";
    reason?: string;
  };
  observability: {
    kind: "broker_field" | "startup_log" | "process_membership";
    field?: string;
    reason?: string;
  };
  unavailableReason?: string;
  environmentLimits: Array<{ name: string; value?: number; description: string }>;
}
export interface DatabaseParameterCapabilitiesV2 {
  contractVersion: "database-parameter-options.v2";
  registryVersion: typeof DATABASE_PARAMETER_REGISTRY_VERSION;
  openedgeVersion: string;
  features: string[];
  platform: string;
  parameters: DatabaseParameterOption[];
}
export { legacyDatabaseParameterOptions } from "./database-parameter-options-v1";

/** Compatibility fields are derived from audited metadata; they do not create native bounds. */
export interface DatabaseParameterOption extends AuditedDatabaseParameter {
  kind: "integer" | "decimal" | "string" | "enum" | "flag";
  minimum?: number;
  maximum?: number;
  values?: Array<string | number>;
  available: boolean;
  reason?: string;
}
export type DatabaseParameterCapabilities = DatabaseParameterCapabilitiesV2;
const definitions = (registry.parameters as AuditedDatabaseParameter[]).map((p) => ({
  ...p,
  kind: (p.valueKind === "presence_flag" || p.valueKind === "valued_boolean"
    ? "flag"
    : p.valueKind) as DatabaseParameterOption["kind"],
  minimum:
    p.multiUser.minimum.status === "documented" && typeof p.multiUser.minimum.value === "number"
      ? p.multiUser.minimum.value
      : undefined,
  maximum:
    p.multiUser.maximum.status === "documented" && typeof p.multiUser.maximum.value === "number"
      ? p.multiUser.maximum.value
      : undefined,
  values:
    p.valueKind === "enum" || ["-SQLTempPageSize", "-lgTruncateFrequency"].includes(p.name)
      ? p.allowedValues
      : undefined,
  available: true
}));
export function databaseParameterDefinition(name: string): DatabaseParameterOption | undefined {
  return definitions.find((p) => p.name === name || p.aliases.includes(name));
}
export function validateDatabaseParameterValue(
  name: string,
  value: unknown
): DatabaseParameterOption {
  const p = databaseParameterDefinition(name);
  if (!p) throw new Error(`database_parameter_not_allowed:${name}`);
  let valid = false;
  switch (p.valueKind) {
    case "presence_flag":
      valid = typeof value === "boolean";
      break;
    case "valued_boolean":
      valid = typeof value === "boolean" || value === 0 || value === 1;
      break;
    case "integer":
    case "decimal": {
      valid =
        typeof value === "number" &&
        Number.isFinite(value) &&
        (p.valueKind !== "integer" || Number.isSafeInteger(value));
      if (valid) {
        const n = value as number;
        valid =
          !!p.allowedValues?.includes(n) ||
          ((p.minimum === undefined || n >= p.minimum) &&
            (p.maximum === undefined || n <= p.maximum) &&
            (!p.increment || n % p.increment === 0));
        if (p.allowedValues?.length && n !== 0)
          valid =
            valid &&
            (!["-SQLTempPageSize", "-lgTruncateFrequency"].includes(p.name) ||
              p.allowedValues.includes(n));
      }
      break;
    }
    case "string":
    case "enum":
      valid =
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 8192 &&
        !/[\0\r\n]/.test(value) &&
        new TextDecoder().decode(new TextEncoder().encode(value)) === value;
      if (valid && p.valueKind === "enum")
        valid = !!p.allowedValues?.some((v) =>
          p.enumCase === "insensitive"
            ? String(v).toLowerCase() === (value as string).toLowerCase()
            : v === value
        );
      break;
  }
  if (!valid) throw new Error(`database_parameter_invalid:${name}`);
  if (typeof value === "string") {
    for (const limit of p.environmentLimits) {
      if (
        limit.value !== undefined &&
        limit.name.includes("bytes") &&
        new TextEncoder().encode(value).length > limit.value
      )
        throw new Error(`database_parameter_invalid:${name}:${limit.name}`);
      if (
        limit.value !== undefined &&
        limit.name.includes("characters") &&
        Array.from(value).length > limit.value
      )
        throw new Error(`database_parameter_invalid:${name}:${limit.name}`);
      if (limit.name === "owned_filename_component" && /[\\/]/.test(value))
        throw new Error(`database_parameter_invalid:${name}:${limit.name}`);
    }
    if (p.name === "-diagFS" && value !== "tab" && !/^[ -~]$/.test(value))
      throw new Error(`database_parameter_invalid:${name}:separator`);
    if (p.name === "-diagPrefix" && (!/^[ -~]+$/.test(value) || /[$*?]/.test(value)))
      throw new Error(`database_parameter_invalid:${name}:ascii`);
    if (
      p.name === "-diagEvent" &&
      !/^(?:locktable|bithold|syserr)(?::-?(?:[0-9]|1[0-5]))?(?:,(?:locktable|bithold|syserr)(?::-?(?:[0-9]|1[0-5]))?)*$/.test(
        value
      )
    )
      throw new Error(`database_parameter_invalid:${name}:event_levels`);
    if (p.name === "-omitLgMsgs" && !/^\d+(?:,\d+){0,15}$/.test(value))
      throw new Error(`database_parameter_invalid:${name}:message_list`);
    if (p.name === "-aiarcdir" && (/\s/.test(value) || value.split(",").some((v) => !v)))
      throw new Error(`database_parameter_invalid:${name}:directory_list`);
    if (p.name === "-lgTruncateTime" && !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value))
      throw new Error(`database_parameter_invalid:${name}:clock_time`);
  }
  return p;
}
export function databaseParameterTokens(name: string, value: unknown): string[] {
  const p = validateDatabaseParameterValue(name, value);
  if (p.valueKind === "presence_flag") return value ? [p.name] : [];
  if (p.valueKind === "valued_boolean") return [p.name, value === true || value === 1 ? "1" : "0"];
  const canonical =
    p.valueKind === "enum" && p.enumCase === "insensitive"
      ? p.allowedValues!.find((v) => String(v).toLowerCase() === String(value).toLowerCase())
      : value;
  return [p.name, String(canonical)];
}
const versionNumber = (v: string) =>
  v
    .split(".")
    .slice(0, 2)
    .reduce((n, p) => n * 100 + Number(p), 0);
export function databaseParameterOptions(
  config: { version?: string; features?: readonly string[]; platform?: string } = {}
): DatabaseParameterCapabilities {
  const version = config.version ?? "12.8";
  const features = [...(config.features ?? [])];
  const platform = config.platform ?? "linux";
  return {
    contractVersion: DATABASE_PARAMETER_OPTIONS_VERSION,
    registryVersion: DATABASE_PARAMETER_REGISTRY_VERSION,
    openedgeVersion: version,
    features,
    platform,
    parameters: definitions.map((p) => {
      const reason =
        p.unavailableReason ??
        (!/^\d+\.\d+(?:\.\d+)*$/.test(version)
          ? "The configured OpenEdge version is unverified."
          : versionNumber(version) < versionNumber(p.minimumVersion)
            ? `Requires an audited OpenEdge ${p.minimumVersion} or later target; configured target is ${version}.`
            : !p.platforms.includes(platform)
              ? `Requires ${p.platforms.join(" or ")}; configured platform is ${platform}.`
              : p.scope !== "primary_database_broker"
                ? `Applies to ${p.scope}, rather than primary database-broker startup.`
                : p.requiredFeatures.find((f) => !features.includes(f))
                  ? `Requires verified ${p.requiredFeatures.filter((f) => !features.includes(f)).join(", ")} capability.`
                  : undefined);
      return { ...p, available: !reason, reason };
    })
  };
}
export function validateScheduledDatabaseParameter(
  name: string,
  value: unknown,
  capabilities = databaseParameterOptions()
): DatabaseParameterOption {
  const definition = validateDatabaseParameterValue(name, value);
  const option = capabilities.parameters.find((p) => p.name === definition.name);
  if (!option?.available)
    throw new Error(
      `database_parameter_unavailable:${name}:${option?.reason ?? "No audited definition for this target."}`
    );
  return option;
}
/** Applies only to explicit effective values; documented defaults are never injected. */
export function validateDatabaseParameterConfiguration(
  values: Record<string, unknown>,
  capabilities?: DatabaseParameterCapabilities
): void {
  const normalized = new Map<string, unknown>();
  for (const [name, value] of Object.entries(values).filter(([n]) => n.startsWith("-"))) {
    const p = capabilities
      ? validateScheduledDatabaseParameter(name, value, capabilities)
      : validateDatabaseParameterValue(name, value);
    if (normalized.has(p.name)) throw new Error(`database_parameter_duplicate:${p.name}`);
    normalized.set(p.name, value);
  }
  for (const [name, value] of normalized) {
    const p = databaseParameterDefinition(name)!;
    if (
      (p.valueKind === "presence_flag" || p.valueKind === "valued_boolean") &&
      (value === false || value === 0)
    )
      continue;
    for (const dep of p.dependencies) {
      const other = normalized.get(dep.name);
      if (
        other === undefined ||
        other === false ||
        (dep.values && !dep.values.includes(other as string | number | boolean))
      )
        throw new Error(`database_parameter_dependency:${name}:${dep.name}`);
    }
  }
  const number = (n: string) =>
    typeof normalized.get(n) === "number" ? (normalized.get(n) as number) : undefined;
  const b = number("-B"),
    b2 = number("-B2");
  if (b !== undefined && b2 !== undefined && b + b2 > 1000000000)
    throw new Error("database_parameter_dependency:-B:-B2:combined_buffer_limit");
  const sets = number("-semsets"),
    users = number("-n");
  if (sets !== undefined && users !== undefined && sets > users + 1)
    throw new Error("database_parameter_dependency:-semsets:-n");
  if (
    (normalized.get("-ssj") === true || normalized.get("-ssj") === 1) &&
    (normalized.get("-threadedServer") === false || normalized.get("-threadedServer") === 0)
  )
    throw new Error("database_parameter_dependency:-ssj:-threadedServer");
  if (normalized.get("-ServerType") === "SQL")
    throw new Error("database_parameter_dependency:-ServerType:owned_pas_requires_abl");
}

export function databaseParameterInput(name: string, display: string): string | number | boolean {
  const p = databaseParameterDefinition(name);
  if (!p) throw new Error(`database_parameter_not_allowed:${name}`);
  if (p.valueKind === "presence_flag") {
    if (display !== "true" && display !== "false")
      throw new Error(`database_parameter_invalid:${name}`);
    return display === "true";
  }
  if (p.valueKind === "valued_boolean") {
    if (!["true", "false", "0", "1"].includes(display))
      throw new Error(`database_parameter_invalid:${name}`);
    return display === "true" || display === "1";
  }
  if (p.valueKind === "integer" || p.valueKind === "decimal") {
    if (!(p.valueKind === "integer" ? /^-?\d+$/ : /^-?(?:\d+(?:\.\d*)?|\.\d+)$/).test(display))
      throw new Error(`database_parameter_invalid:${name}`);
    return Number(display);
  }
  return display;
}

export function validateDatabaseParameterPaths(
  values: Record<string, unknown>,
  databaseName: string
): void {
  const owned = `/psc/wrk/${databaseName}`;
  const supplied = "/run/parkbench/seed/db";
  for (const [name, value] of Object.entries(values)) {
    const p = databaseParameterDefinition(name);
    if (!p || value === false) continue;
    if (p.ownership.rule === "managed_infrastructure")
      throw new Error(`database_parameter_ownership:${name}`);
    if (p.ownership.rule === "owned_path" || p.ownership.rule === "controlled_input") {
      if (typeof value !== "string") throw new Error(`database_parameter_ownership:${name}`);
      for (const path of p.name === "-aiarcdir" ? value.split(",") : [value]) {
        if (
          path.split("/").some((part) => part === ".." || part === ".") ||
          path.includes("\\") ||
          !(
            path === owned ||
            path.startsWith(owned + "/") ||
            (p.ownership.rule === "controlled_input" &&
              (path === supplied || path.startsWith(supplied + "/")))
          )
        )
          throw new Error(`database_parameter_ownership:${name}:requires_owned_or_supplied_path`);
      }
    }
  }
}
