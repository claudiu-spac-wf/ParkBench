/** Scheduling capabilities for the primary OpenEdge database broker. */
export const LEGACY_DATABASE_PARAMETER_OPTIONS_VERSION = "database-parameter-options.v1" as const;

export type DatabaseParameterKind = "integer" | "decimal" | "enum" | "flag";
export interface DatabaseParameterOption {
  name: string;
  description: string;
  kind: DatabaseParameterKind;
  unit?: string;
  minimum?: number;
  maximum?: number;
  values?: string[];
  scope: "primary_database_broker";
  feature?: string;
  available: boolean;
  reason?: string;
}
export interface DatabaseParameterCapabilities {
  contractVersion: typeof LEGACY_DATABASE_PARAMETER_OPTIONS_VERSION;
  openedgeVersion: string;
  parameters: DatabaseParameterOption[];
}
type Definition = Omit<DatabaseParameterOption, "available" | "reason" | "scope">;

const integer = (
  name: string,
  description: string,
  minimum = 0,
  unit?: string,
  feature?: string
): Definition => ({
  name,
  description,
  kind: "integer",
  minimum,
  maximum: 2147483647,
  unit,
  feature
});
const flag = (name: string, description: string, feature?: string): Definition => ({
  name,
  description,
  kind: "flag",
  feature
});

// The feature keys are explicit deployment capabilities, never guessed from a filename.
const DEFINITIONS: Definition[] = [
  integer("-B", "Blocks in the primary database buffer pool.", 1, "blocks"),
  integer(
    "-B2",
    "Blocks in the alternate database buffer pool; setting it enables that pool.",
    1,
    "blocks"
  ),
  integer("-hash", "Lookup entries for the primary buffer pool.", 1, "entries"),
  integer("-lruskips", "Accesses before a primary buffer moves on its LRU chain.", 0, "accesses"),
  integer(
    "-lru2skips",
    "Accesses before an alternate buffer moves on its LRU chain.",
    0,
    "accesses",
    "alternate_buffer_pool"
  ),
  integer("-aibufs", "Buffers used for after-image writes.", 1, "buffers", "after_imaging"),
  {
    name: "-bibufs",
    kind: "integer",
    minimum: 3,
    unit: "buffers",
    description:
      "Before-image buffers: minimum 3; documented multi-user default 64; maximum not specified in OpenEdge 12.8 documentation. BIW is independent and is not automatically enabled. ParkBench requires a safely representable integer."
  },
  flag("-directio", "Use unbuffered I/O for database files.", "direct_io"),
  integer(
    "-G",
    "Delay before a before-image cluster can be reused.",
    0,
    "seconds",
    "recovery_tuning"
  ),
  integer("-groupdelay", "Delay a commit to group transactions.", 0, "milliseconds"),
  integer("-Mf", "Delay the final before-image record write.", 0, undefined, "write_tuning"),
  integer("-L", "Entries available in the record-lock table.", 1, "locks"),
  integer("-lkhash", "Hash entries used to access the record-lock table.", 1, "entries"),
  integer("-spin", "Latch attempts before a process pauses.", 0, "attempts"),
  integer("-nap", "Initial pause after latch spin attempts.", 0, undefined),
  integer("-napmax", "Maximum pause after failed latch attempts.", 0, "milliseconds"),
  integer("-napstep", "Increase between successive latch pauses.", 0),
  integer("-mux", "Granularity of user multiplex latches.", 1, undefined, "multiplex_latches"),
  integer("-TXERetryLimit", "Transaction-end lock acquisition retries.", 0, "retries"),
  integer(
    "-TXESkipLimit",
    "Limit for skipping a contended transaction-end lock.",
    0,
    undefined,
    "transaction_end_skip"
  ),
  integer("-omsize", "Entries in the storage-object cache.", 1, "entries"),
  integer(
    "-recspacesearchdepth",
    "Depth when searching for a free record slot.",
    1,
    undefined,
    "record_allocation_tuning"
  ),
  integer("-n", "Maximum database users and processes.", 1, "connections"),
  integer("-Mxs", "Shared-memory overflow area size.", 1, undefined, "shared_memory_tuning"),
  flag("-pinshm", "Prevent database shared memory from being swapped.", "pin_shared_memory"),
  integer("-semsets", "Semaphore sets available to the broker.", 1, "sets", "unix_semaphores"),
  integer(
    "-shmsegsize",
    "Maximum shared-memory segment size.",
    1,
    undefined,
    "shared_memory_tuning"
  ),
  integer("-Ma", "Maximum remote clients per database server.", 1, "clients", "remote_clients"),
  integer(
    "-Mi",
    "Remote clients per server before another server starts.",
    1,
    "clients",
    "remote_clients"
  ),
  integer("-Mn", "Maximum remote-client servers.", 1, "servers", "remote_clients"),
  integer("-Mpb", "Maximum servers started by one broker.", 1, "servers", "remote_clients"),
  integer("-Mp", "Maximum servers for one network protocol.", 1, "servers", "remote_clients"),
  integer("-Mm", "Network message buffer size.", 1, undefined, "remote_clients"),
  flag(
    "-prefetchDelay",
    "Delay a network response to gather prefetched records.",
    "remote_prefetch"
  ),
  integer(
    "-prefetchFactor",
    "Minimum filled share of a prefetched network message.",
    0,
    "percent",
    "remote_prefetch"
  ),
  integer(
    "-prefetchNumRecs",
    "Records prefetched into a network response.",
    1,
    "records",
    "remote_prefetch"
  ),
  integer(
    "-prefetchPriority",
    "Prefetched records added before another poll.",
    1,
    "records",
    "remote_prefetch"
  ),
  flag("-ssj", "Process eligible joins in the remote database server.", "remote_clients"),
  flag("-threadedServer", "Use threads for broker-spawned remote servers.", "remote_clients"),
  integer(
    "-threadedServerStack",
    "Stack space for each remote server thread.",
    1,
    undefined,
    "threaded_server"
  ),
  integer("-ecsize", "Entries in the encryption cache.", 1, "entries", "encryption"),
  integer("-secsize", "Entries in the security cache.", 1, "entries", "authentication_gateway"),
  integer("-cdcsize", "Entries in the change-data-capture cache.", 1, "entries", "cdc"),
  integer(
    "-mtpmsize",
    "Entries in the multitenancy partition cache.",
    1,
    "entries",
    "multitenancy"
  ),
  integer("-LGovernor", "Tenant share of the record-lock table.", 1, "locks", "multitenancy"),
  integer("-nGovernor", "Maximum logins for one tenant.", 1, "connections", "multitenancy"),
  integer("-pica", "Replication communication area size.", 1, undefined, "replication"),
  integer("-picanap", "Wait before retrying the replication queue.", 0, undefined, "replication"),
  integer("-SQLCursors", "Maximum open SQL cursors.", 1, "cursors", "sql"),
  integer("-SQLStmtCache", "Cached SQL statements.", 1, "statements", "sql"),
  integer("-SQLTempBuff", "Memory buffer for SQL temporary sorting.", 1, undefined, "sql"),
  integer("-SQLTempDisk", "Disk space for SQL temporary sorting.", 1, undefined, "sql"),
  integer("-SQLTempPageSize", "Page size of SQL temporary tables.", 1, undefined, "sql"),
  integer("-SQLStack", "Stack space for SQL server execution.", 1, undefined, "sql")
];

export function legacyDatabaseParameterDefinition(name: string): Definition | undefined {
  return DEFINITIONS.find((definition) => definition.name === name);
}

export function validateLegacyDatabaseParameterValue(name: string, value: unknown): Definition {
  const option = legacyDatabaseParameterDefinition(name);
  if (!option) throw new Error(`database_parameter_not_allowed:${name}`);
  const valid =
    option.kind === "flag"
      ? typeof value === "boolean"
      : option.kind === "integer"
        ? typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= (option.minimum ?? 0) &&
          value <= (option.maximum ?? Number.MAX_SAFE_INTEGER)
        : option.kind === "decimal"
          ? typeof value === "number" &&
            Number.isFinite(value) &&
            value >= (option.minimum ?? -Infinity) &&
            value <= (option.maximum ?? Infinity)
          : typeof value === "string" && Boolean(option.values?.includes(value));
  if (!valid) throw new Error(`database_parameter_invalid:${name}`);
  return option;
}

export function legacyDatabaseParameterOptions(
  config: {
    version?: string;
    features?: readonly string[];
  } = {}
): DatabaseParameterCapabilities {
  const version = config.version ?? "12.2";
  const versionSupported = /^12\.(?:2|[3-9])(?:\.|$)/.test(version);
  const features = new Set(config.features ?? []);
  return {
    contractVersion: LEGACY_DATABASE_PARAMETER_OPTIONS_VERSION,
    openedgeVersion: version,
    parameters: DEFINITIONS.map((definition) => {
      const reason = !versionSupported
        ? "openedge_version_unverified"
        : definition.feature && !features.has(definition.feature)
          ? `${definition.feature}_required`
          : undefined;
      return { ...definition, scope: "primary_database_broker", available: !reason, reason };
    })
  };
}

export function validateScheduledDatabaseParameter(
  name: string,
  value: unknown,
  capabilities = legacyDatabaseParameterOptions()
): DatabaseParameterOption {
  const option = capabilities.parameters.find((item) => item.name === name);
  if (!option) throw new Error(`database_parameter_not_allowed:${name}`);
  if (!option.available) throw new Error(`database_parameter_unavailable:${name}:${option.reason}`);
  validateLegacyDatabaseParameterValue(name, value);
  return option;
}
