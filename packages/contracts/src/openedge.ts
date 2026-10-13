import Ajv from "ajv/dist/2020";
import openEdgeDbMetricCatalog from "./openedge-db-metric-catalog.json";
import { loadContractSchema } from "./schema-loader";

export const OPENEDGE_CONTRACT_VERSION = "image-build.v2" as const;
export const WORKLOAD_RUNNER_CONTRACT_VERSION = "workload-runner.v1" as const;
export const OPENEDGE_WORKLOAD_TIMEOUT_MS = 60_000;
export const OPENEDGE_WORKLOAD_BODY_LIMIT_BYTES = 1024 * 1024;
export const OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION = 4 as const;

export const OPENEDGE_DB_AVAILABILITY_VALUES = [
  "available",
  "unsupported",
  "not_configured",
  "not_licensed",
  "not_collected",
  "temporarily_unavailable"
] as const;
export const OPENEDGE_DB_AVAILABILITY_REASONS = [
  "available",
  "vst_missing",
  "field_missing",
  "alternate_pool_disabled",
  "license_required",
  "statistics_range_excludes_object",
  "statistics_disabled",
  "source_disabled",
  "not_applicable",
  "collection_timeout",
  "collection_error"
] as const;
export const OPENEDGE_DB_FAMILY_NAMES = Object.keys(
  openEdgeDbMetricCatalog.families
) as OpenEdgeDbFamilyName[];
export const OPENEDGE_DB_FAMILY_SOURCES = openEdgeDbMetricCatalog.families as Record<
  OpenEdgeDbFamilyName,
  string[]
>;
export const OPENEDGE_DB_METRIC_CATALOG =
  openEdgeDbMetricCatalog.entries as OpenEdgeDbMetricDefinition[];
/** Retained-v2 table cap; v3 retains every inventoried table. Index scope remains bounded. */
export const OPENEDGE_DB_LABEL_TABLE_LIMIT = 64;
export const OPENEDGE_DB_LABEL_INDEX_LIMIT = 256;

export interface OpenEdgeDbLabelSet {
  tables: readonly string[];
  indexes: readonly string[];
  latches?: readonly OpenEdgeDbLatchInstance[];
  database?: string;
}

const OTHER_ONLY: OpenEdgeDbLabelSet = { tables: ["other"], indexes: ["other"] };
let activeLabelSet: OpenEdgeDbLabelSet | undefined;

function withOther(names: readonly string[], limit: number): string[] {
  return [
    ...[
      ...new Set(names.filter((name) => typeof name === "string" && name && name !== "other"))
    ].slice(0, limit),
    "other"
  ];
}

export function setOpenEdgeDbLabelSet(labels: OpenEdgeDbLabelSet | undefined): void {
  activeLabelSet = labels
    ? {
        tables: withOther(labels.tables ?? [], Number.MAX_SAFE_INTEGER),
        indexes: withOther(labels.indexes ?? [], OPENEDGE_DB_LABEL_INDEX_LIMIT)
      }
    : undefined;
}

export function openEdgeDbLabelSet(): OpenEdgeDbLabelSet {
  return activeLabelSet ?? OTHER_ONLY;
}

/**
 * Per-family availability/measurement bound: up to 257 index labels (seed cap plus "other")
 * times the index operations, with headroom; mirrors maxItems in the observer v2 schema.
 */
export const OPENEDGE_DB_FAMILY_MEASUREMENT_LIMIT = 8192;

/** The ParkBenchDB benchmark tables, in schema order (dashboard tie-break order). */
export const PARKBENCH_DB_TABLES = [
  "Currency",
  "Country",
  "ExchangeRate",
  "Branch",
  "Employee",
  "AccountType",
  "InterestRateHistory",
  "TransactionType",
  "MerchantCategory",
  "Merchant",
  "Customer",
  "CustomerAddress",
  "CustomerContact",
  "CustomerDocument",
  "CustomerNote",
  "Account",
  "AccountHolder",
  "Payee",
  "ScheduledPayment",
  "Card",
  "Loan",
  "StatementDocument",
  "AccountStatement",
  "MonthlyBalance",
  "CreditTransaction",
  "Transfer",
  "LoanPayment",
  "LoginEvent",
  "DebitTransaction",
  "CardAuthorization",
  "AuditLog",
  "BenchmarkTableInfo"
] as const;

export type OpenEdgeDbFamilyName = keyof typeof openEdgeDbMetricCatalog.families;
export type OpenEdgeDbAvailability = (typeof OPENEDGE_DB_AVAILABILITY_VALUES)[number];
export type OpenEdgeDbAvailabilityReason = (typeof OPENEDGE_DB_AVAILABILITY_REASONS)[number];
export type OpenEdgeDbMetricName = (typeof openEdgeDbMetricCatalog.metricNames)[number];
export type OpenEdgeDbMetricType = "counter" | "gauge";
export interface OpenEdgeDbMetricDefinition {
  name: OpenEdgeDbMetricName;
  family: OpenEdgeDbFamilyName;
  type: OpenEdgeDbMetricType;
  unit: string;
  sources: string[];
  dimensions: string[];
  sourceFields: string[];
  fieldMapping: string;
  semantics: string;
  sinceProtocol?: number;
}
export interface OpenEdgeDbDatabaseIdentity {
  productVersion: string;
  startedAt: string;
  statisticsResetAt: string;
}
export interface OpenEdgeDbAvailabilityMeasurement {
  name: OpenEdgeDbMetricName;
  availability: OpenEdgeDbAvailability;
  source: string;
  reason: OpenEdgeDbAvailabilityReason;
  labels?: Record<string, string>;
}
export interface OpenEdgeDbObserverFamily {
  name: OpenEdgeDbFamilyName;
  sources: string[];
  measurements: OpenEdgeDbAvailabilityMeasurement[];
}
export interface OpenEdgeDbObserverMetric {
  name: OpenEdgeDbMetricName;
  type: OpenEdgeDbMetricType;
  unit: string;
  value: number;
  source: string;
  labels: Record<string, string>;
}
export interface OpenEdgeDbObserverPayloadV2 {
  protocolVersion: 2;
  database: OpenEdgeDbDatabaseIdentity;
  collectedAt: string;
  families: OpenEdgeDbObserverFamily[];
  metrics: OpenEdgeDbObserverMetric[];
}

export interface OpenEdgeDbObserverPayloadV3 extends Omit<
  OpenEdgeDbObserverPayloadV2,
  "protocolVersion"
> {
  protocolVersion: 3;
  labels: { tables: string[]; indexes: string[] };
}
export interface OpenEdgeDbLatchInstance {
  latch_name: string;
  latch_type: string;
  latch_id: string;
  availability: "available";
}
export interface OpenEdgeDbLatchInventory {
  runId: string;
  database: string;
  databaseEpoch: string;
  capturedAt: string;
  authoritativePublisher: "endpoint";
  complete: true;
  instances: OpenEdgeDbLatchInstance[];
}
export interface OpenEdgeDbObserverPayloadV4 extends Omit<
  OpenEdgeDbObserverPayloadV3,
  "protocolVersion" | "database"
> {
  protocolVersion: 4;
  database: OpenEdgeDbDatabaseIdentity & { name: string };
  latchInventory: OpenEdgeDbLatchInventory;
}
export type OpenEdgeDbObserverPayload =
  OpenEdgeDbObserverPayloadV2 | OpenEdgeDbObserverPayloadV3 | OpenEdgeDbObserverPayloadV4;

const OPENEDGE_DB_OPERATION_VALUES: Record<string, string[]> = {
  database_table_operations_total: ["create", "read", "update", "delete"],
  table_operations_total: ["create", "read", "update", "delete", "os_read"],
  index_operations_total: ["create", "read", "delete", "block_delete", "split", "os_read"],
  bi_io_operations_total: ["read", "write"],
  lock_requests_total: ["exclusive", "record_get", "share", "upgrade"],
  lock_grants_total: ["exclusive", "record_get", "share", "upgrade"],
  lock_waits_total: ["exclusive", "record_get", "share", "upgrade"]
};

export function getOpenEdgeDbAvailabilityTuples(
  definition: OpenEdgeDbMetricDefinition,
  labels: OpenEdgeDbLabelSet = openEdgeDbLabelSet()
): Array<Record<string, string>> {
  const dimensions = definition.dimensions.filter((dimension) => dimension !== "database_epoch");
  if (definition.sinceProtocol === 4)
    return (labels.latches ?? []).map(({ latch_name, latch_type, latch_id }) => ({
      database: labels.database!,
      latch_name,
      latch_type,
      latch_id
    }));
  if (dimensions.length === 0) return [{}];
  if (dimensions.length === 1 && dimensions[0] === "pool")
    return ["primary", "alternate"].map((pool) => ({ pool }));
  if (dimensions.length === 1 && dimensions[0] === "operation")
    return (OPENEDGE_DB_OPERATION_VALUES[definition.name] ?? []).map((operation) => ({
      operation
    }));
  if (definition.name === "table_operations_total")
    return labels.tables.flatMap((table) =>
      OPENEDGE_DB_OPERATION_VALUES.table_operations_total.map((operation) => ({ table, operation }))
    );
  if (definition.name === "index_operations_total")
    return labels.indexes.flatMap((index) =>
      OPENEDGE_DB_OPERATION_VALUES.index_operations_total.map((operation) => ({ index, operation }))
    );
  return [];
}

const availabilityReasonByStatus: Record<OpenEdgeDbAvailability, OpenEdgeDbAvailabilityReason[]> = {
  available: ["available"],
  unsupported: ["vst_missing", "field_missing"],
  not_configured: [
    "alternate_pool_disabled",
    "statistics_range_excludes_object",
    "statistics_disabled",
    "source_disabled"
  ],
  not_licensed: ["license_required"],
  not_collected: ["not_applicable"],
  temporarily_unavailable: ["collection_timeout", "collection_error"]
};
const openEdgeDbSchemaValidator = new Ajv({ allErrors: true, strict: false }).compile(
  loadContractSchema("openedge-db-observer-v2")
);

const openEdgeDbV3SchemaValidator = new Ajv({ allErrors: true, strict: false }).compile(
  loadContractSchema("openedge-db-observer-v3")
);
export function validateOpenEdgeDbObserverPayloadV3(input: unknown): OpenEdgeDbObserverPayloadV3 {
  if (!openEdgeDbV3SchemaValidator(input))
    throw new Error(
      `openedge_db_observer_contract_invalid:${openEdgeDbV3SchemaValidator.errors?.[0]?.instancePath ?? "/"}`
    );
  const payload = input as OpenEdgeDbObserverPayloadV3;
  const labels = {
    tables: withOther(payload.labels.tables, Number.MAX_SAFE_INTEGER),
    indexes: withOther(payload.labels.indexes, OPENEDGE_DB_LABEL_INDEX_LIMIT)
  };
  return validateOpenEdgeDbPayload(input, labels, 3) as OpenEdgeDbObserverPayloadV3;
}
export function validateOpenEdgeDbObserverPayload(input: unknown): OpenEdgeDbObserverPayload {
  if ((input as any)?.protocolVersion === 4) return validateOpenEdgeDbObserverPayloadV4(input);
  return (input as any)?.protocolVersion === 3
    ? validateOpenEdgeDbObserverPayloadV3(input)
    : validateOpenEdgeDbObserverPayloadV2(input);
}

const openEdgeDbV4SchemaValidator = new Ajv({ allErrors: true, strict: false }).compile(
  loadContractSchema("openedge-db-observer-v4")
);
const openEdgeDbLatchInventoryValidator = new Ajv({ allErrors: true, strict: false }).compile(
  (loadContractSchema("openedge-db-observer-v4") as any).properties.latchInventory
);
export function validateOpenEdgeDbLatchInventory(
  input: unknown,
  runId?: string
): OpenEdgeDbLatchInventory {
  if (!openEdgeDbLatchInventoryValidator(input))
    throw new Error("openedge_db_observer_contract_invalid:latch_inventory");
  const inventory = input as OpenEdgeDbLatchInventory;
  if (
    (runId !== undefined && inventory.runId !== runId) ||
    !Number.isFinite(Date.parse(inventory.capturedAt)) ||
    new Set(inventory.instances.map((t) => t.latch_id)).size !== inventory.instances.length ||
    inventory.instances.some((t) => [t.latch_name, t.latch_type, t.latch_id].some((v) => !v.trim()))
  )
    throw new Error("openedge_db_observer_contract_invalid:inventory_owner");
  return inventory;
}
export function validateOpenEdgeDbObserverPayloadV4(input: unknown): OpenEdgeDbObserverPayloadV4 {
  if (!openEdgeDbV4SchemaValidator(input))
    throw new Error(
      `openedge_db_observer_contract_invalid:${openEdgeDbV4SchemaValidator.errors?.[0]?.instancePath ?? "/"}`
    );
  const payload = input as OpenEdgeDbObserverPayloadV4;
  const inventory = payload.latchInventory;
  const fail = (code: string): never => {
    throw new Error(`openedge_db_observer_contract_invalid:${code}`);
  };
  if (
    inventory.database !== payload.database.name ||
    inventory.databaseEpoch !==
      databaseEpoch(payload.database.startedAt, payload.database.statisticsResetAt) ||
    inventory.capturedAt !== payload.collectedAt
  )
    fail("inventory_owner");
  const ids = new Set<string>();
  for (const instance of inventory.instances) {
    if (
      [instance.latch_name, instance.latch_type, instance.latch_id].some((v) => !v.trim()) ||
      ids.has(instance.latch_id)
    )
      fail("inventory_identity");
    ids.add(instance.latch_id);
  }
  return validateOpenEdgeDbPayload(
    input,
    {
      tables: withOther(payload.labels.tables, Number.MAX_SAFE_INTEGER),
      indexes: withOther(payload.labels.indexes, OPENEDGE_DB_LABEL_INDEX_LIMIT),
      latches: inventory.instances,
      database: inventory.database
    },
    4
  ) as OpenEdgeDbObserverPayloadV4;
}

export function databaseEpoch(startedAt: string, statisticsResetAt: string): string {
  return JSON.stringify([startedAt.trim(), statisticsResetAt.trim()]);
}

export function selectOpenEdgeStatisticsResetTimestamp(
  timezoneAwareValue?: string | null,
  fallbackValue?: string | null
): string {
  const selected = timezoneAwareValue?.trim() || fallbackValue?.trim();
  if (!selected) throw new Error("openedge_db_observer_contract_invalid:statistics_reset_missing");
  return selected;
}

export function validateOpenEdgeDbObserverPayloadV2(input: unknown): OpenEdgeDbObserverPayloadV2 {
  if (!openEdgeDbSchemaValidator(input)) {
    const error = openEdgeDbSchemaValidator.errors?.[0];
    throw new Error(`openedge_db_observer_contract_invalid:${error?.instancePath ?? "/"}`);
  }
  const labels = openEdgeDbLabelSet();
  return validateOpenEdgeDbPayload(
    input,
    { tables: withOther(labels.tables, OPENEDGE_DB_LABEL_TABLE_LIMIT), indexes: labels.indexes },
    2
  ) as OpenEdgeDbObserverPayloadV2;
}
function validateOpenEdgeDbPayload(
  input: unknown,
  labelSet: OpenEdgeDbLabelSet,
  version: 2 | 3 | 4
): OpenEdgeDbObserverPayload {
  const payload = input as OpenEdgeDbObserverPayload;
  const dimensionSets = { tables: new Set(labelSet.tables), indexes: new Set(labelSet.indexes) };
  const fail = (code: string): never => {
    throw new Error(`openedge_db_observer_contract_invalid:${code}`);
  };
  const { database } = payload;
  if (!/^12\.8\.\d+(?:\.\d+){1,2}$/.test(database.productVersion)) fail("product_version_invalid");
  if (
    !database.startedAt ||
    database.startedAt !== database.startedAt.trim() ||
    !database.statisticsResetAt ||
    database.statisticsResetAt !== database.statisticsResetAt.trim()
  )
    fail("database_epoch_inputs_invalid");
  if (!Number.isFinite(Date.parse(payload.collectedAt))) fail("collected_at_invalid");

  const catalog = OPENEDGE_DB_METRIC_CATALOG.filter((d) => (d.sinceProtocol ?? 2) <= version);
  const definitions = new Map(catalog.map((definition) => [definition.name, definition]));
  const familyMap = new Map<string, OpenEdgeDbObserverFamily>();
  if (payload.families.length !== OPENEDGE_DB_FAMILY_NAMES.length) fail("family_set_incomplete");
  for (const family of payload.families) {
    if (familyMap.has(family.name)) fail("family_duplicate");
    const expectedSources = OPENEDGE_DB_FAMILY_SOURCES[family.name];
    // Allocation evidence is additive; earlier persisted payloads lack _BuffStatus.
    if (
      JSON.stringify(family.sources) !== JSON.stringify(expectedSources) &&
      JSON.stringify(family.sources) !==
        JSON.stringify(expectedSources.filter((source) => source !== "_BuffStatus"))
    )
      fail("family_sources_invalid");
    familyMap.set(family.name, family);
  }
  if (OPENEDGE_DB_FAMILY_NAMES.some((name) => !familyMap.has(name))) fail("family_missing");

  // Expected label tuples per metric as canonical keys: seed label sets make these families
  // large (hundreds of indexes x operations), so lookups must not scan the tuple lists.
  const tupleKey = (labels: Record<string, string>): string => JSON.stringify(sortedRecord(labels));
  const expectedTuples = new Map(
    catalog.map((definition) => [
      definition.name,
      new Set(getOpenEdgeDbAvailabilityTuples(definition, labelSet).map(tupleKey))
    ])
  );
  const presentTuples = new Map<string, Set<string>>();
  const availabilityMap = new Map<string, OpenEdgeDbAvailabilityMeasurement>();
  for (const family of payload.families) {
    if (version !== 3 && family.measurements.length > OPENEDGE_DB_FAMILY_MEASUREMENT_LIMIT)
      fail("availability_cardinality_exceeded");
    for (const measurement of family.measurements) {
      const definition = definitions.get(measurement.name);
      if (!definition || definition.family !== family.name) fail("measurement_name_invalid");
      if (!definition.sources.includes(measurement.source)) fail("measurement_source_invalid");
      if (!availabilityReasonByStatus[measurement.availability].includes(measurement.reason))
        fail("availability_reason_invalid");
      const measurementKey = tupleKey(measurement.labels ?? {});
      if (!expectedTuples.get(definition.name)!.has(measurementKey))
        fail("availability_dimensions_invalid");
      if (!presentTuples.has(definition.name)) presentTuples.set(definition.name, new Set());
      presentTuples.get(definition.name)!.add(measurementKey);
      const key = seriesKey(measurement.name, measurement.labels ?? {});
      if (availabilityMap.has(key)) fail("availability_duplicate");
      availabilityMap.set(key, measurement);
    }
  }
  for (const definition of catalog) {
    // Additive raw free-list evidence was not emitted by earlier v2/v3 collectors.
    if (definition.name === "buffer_pool_free_list_buffers" && !presentTuples.has(definition.name))
      continue;
    const present = presentTuples.get(definition.name) ?? new Set<string>();
    for (const key of expectedTuples.get(definition.name)!)
      if (!present.has(key)) fail("availability_tuple_missing");
  }

  const epoch = databaseEpoch(database.startedAt, database.statisticsResetAt);
  const sampleMap = new Map<string, OpenEdgeDbObserverMetric>();
  for (const metric of payload.metrics) {
    const definition = definitions.get(metric.name);
    if (!definition || definition.type !== metric.type || definition.unit !== metric.unit)
      fail("metric_identity_invalid");
    if (!definition.sources.includes(metric.source)) fail("metric_source_invalid");
    if (!Number.isFinite(metric.value)) fail("metric_value_invalid");
    if (
      definition.sinceProtocol === 4 &&
      (metric.value < 0 ||
        (definition.name === "latch_named_waits_total" && !Number.isSafeInteger(metric.value)))
    )
      fail("metric_value_invalid");
    const expectedDimensions = new Set(definition.dimensions);
    const keys = Object.keys(metric.labels).sort();
    if (keys.some((key) => !expectedDimensions.has(key))) fail("metric_label_invalid");
    for (const dimension of expectedDimensions) {
      if (!(dimension in metric.labels)) fail("metric_label_missing");
    }
    if (metric.labels.database_epoch && metric.labels.database_epoch.length > 256)
      fail("database_epoch_invalid");
    if (
      (definition.type === "counter" ||
        definition.name === "buffer_pool_cumulative_cache_hit_ratio") &&
      metric.labels.database_epoch !== epoch
    )
      fail("database_epoch_mismatch");
    validateMetricDimensions(definition, metric.labels, fail, dimensionSets);
    const tupleLabels = Object.fromEntries(
      Object.entries(metric.labels).filter(([key]) => key !== "database_epoch")
    );
    const key = seriesKey(metric.name, tupleLabels);
    const availability = availabilityMap.get(key);
    if (!availability || availability.availability !== "available")
      fail("metric_without_availability");
    if (availability.source !== metric.source) fail("source_disagreement");
    if (sampleMap.has(key)) fail("metric_series_duplicate");
    sampleMap.set(key, metric);
  }
  for (const [key, availability] of availabilityMap) {
    if ((availability.availability === "available") !== sampleMap.has(key))
      fail("availability_sample_disagreement");
  }
  return payload;
}

function validateMetricDimensions(
  definition: OpenEdgeDbMetricDefinition,
  labels: Record<string, string>,
  fail: (code: string) => never,
  sets: { tables: Set<string>; indexes: Set<string> }
): void {
  if (labels.pool && !["primary", "alternate"].includes(labels.pool)) fail("pool_label_invalid");
  if (
    labels.operation &&
    !(OPENEDGE_DB_OPERATION_VALUES[definition.name] ?? []).includes(labels.operation)
  )
    fail("operation_label_invalid");
  if (labels.table && !sets.tables.has(labels.table)) fail("table_label_invalid");
  if (labels.index && !sets.indexes.has(labels.index)) fail("index_label_invalid");
}
function sortedRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  );
}
function seriesKey(name: string, labels: Record<string, string>): string {
  return `${name}:${JSON.stringify(sortedRecord(labels))}`;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ImageStage = "generic" | "final";
export type OpenEdgeBuildInputKind =
  "db-base" | "pasoe-base" | "jdk-image" | "license" | "progress-assets" | "workloads";

export interface OpenEdgeBuildInput {
  kind: OpenEdgeBuildInputKind;
  reference: string;
  version: string;
  private: boolean;
}

export interface ImageArtifact {
  repository: string;
  tag: string;
  reference: string;
}

export type FileArtifactKind = "pasoe-runner-archive";
export interface FileArtifact {
  path: string;
  kind: FileArtifactKind;
}

/** The seed whose schema the final-stage r-code was compiled against. */
/** Reference seed identity and hash of the .df loaded into an empty compiler database. */
export interface CompileSchemaReference {
  seed: string;
  databaseName: string;
  schemaSha256?: string;
}

export interface WorkloadProcedure {
  procName: string;
  /** Source paths are build-local and must not be emitted in manifests. */
  sourcePath?: string;
  compiled: boolean;
  signature: "INPUT SingleParam AS LONGCHAR";
  pathStatus: "canonical";
  contract?: {
    path: string;
  };
  imageReference?: string;
}

export interface BenchmarkImageManifest {
  schemaVersion: typeof OPENEDGE_CONTRACT_VERSION;
  imageStage: ImageStage;
  parkBenchReady: boolean;
  createdAt: string;
  db: ImageArtifact;
  pasoe: ImageArtifact;
  observer: ImageArtifact;
  observerContract: {
    protocolVersion: 2 | 3 | 4;
    tableCoverage?: "all_tables" | "capped_v2";
    parameterCaptureVersion: "openedge-db-parameter-capture.v1";
  };
  jdk: ImageArtifact;
  databaseName: string;
  /** Present on final-stage manifests only. */
  compileSchema?: CompileSchemaReference;
  runnerArchive: FileArtifact;
  workloadRoot: "Workloads";
  buildDurationMs: number;
  totalBuildDurationMs?: number;
  inputs: OpenEdgeBuildInput[];
  workloads?: WorkloadProcedure[];
}

export type WorkExecutionStatus = "succeeded" | "invalid" | "not_found" | "timed_out" | "failed";

export interface WorkRequest {
  procName: string;
  input: JsonValue;
  inputDomain?: "json_value";
  requestId?: string;
  receivedAt?: string;
}

export interface WorkExecution {
  status: WorkExecutionStatus;
  procName?: string;
  elapsedMs?: number;
  timeoutMs?: typeof OPENEDGE_WORKLOAD_TIMEOUT_MS;
  latencyObservation?: "complete" | "lower_bound";
  errorCode?:
    | "invalid_json"
    | "invalid_work_request"
    | "unsafe_proc_name"
    | "workload_not_found"
    | "workload_timeout"
    | "database_schema_invalid"
    | "workload_failed";
  requestId: string;
}

export interface WorkSuccessAcknowledgement {
  ok: true;
  procName: string;
  elapsedMs: number;
  requestId?: string;
}

export interface WorkErrorAcknowledgement {
  ok: false;
  error:
    | "invalid_json"
    | "invalid_work_request"
    | "unsafe_proc_name"
    | "workload_not_found"
    | "workload_timeout"
    | "database_schema_invalid"
    | "workload_failed";
  requestId: string;
}

export type WorkAcknowledgement = WorkSuccessAcknowledgement | WorkErrorAcknowledgement;
