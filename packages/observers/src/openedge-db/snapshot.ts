import {
  OPENEDGE_DB_FAMILY_NAMES,
  OPENEDGE_DB_FAMILY_SOURCES,
  OPENEDGE_DB_METRIC_CATALOG,
  OpenEdgeDbAvailability,
  OpenEdgeDbAvailabilityReason,
  OpenEdgeDbMetricDefinition,
  OpenEdgeDbObserverMetric,
  OpenEdgeDbObserverPayload,
  OpenEdgeDbLabelSet,
  openEdgeDbLabelSet,
  OPENEDGE_DB_LABEL_TABLE_LIMIT,
  getOpenEdgeDbAvailabilityTuples,
  selectOpenEdgeStatisticsResetTimestamp,
  databaseEpoch,
  OpenEdgeDbLatchInventory,
  setOpenEdgeDbLabelSet
} from "../../../contracts/src/openedge";

type SnapshotRecord = Record<string, string | number>;
interface CollectorSnapshot {
  protocolVersion: number;
  database: {
    name?: string;
    productVersion: string;
    startedAt: string;
    statisticsResetAt: string;
  };
  collectedAt: string;
  snapshot: Record<string, SnapshotRecord[]>;
  unavailableSources?: string[];
  latchInventory?: {
    complete: boolean;
    count: number;
    runId: string;
    authoritativePublisher: string;
  };
  /** Table and index names read from the run database's metaschema (capped by the collector). */
  labels?: { tables?: string[]; indexes?: string[] };
}

interface CollectedValue {
  source: string;
  value?: number;
  availability: OpenEdgeDbAvailability;
  reason: OpenEdgeDbAvailabilityReason;
}

const operationValues: Record<string, string[]> = {
  database_table_operations_total: ["create", "read", "update", "delete"],
  table_operations_total: ["create", "read", "update", "delete", "os_read"],
  index_operations_total: ["create", "read", "delete", "block_delete", "split", "os_read"],
  bi_io_operations_total: ["read", "write"],
  lock_requests_total: ["exclusive", "record_get", "share", "upgrade"],
  lock_grants_total: ["exclusive", "record_get", "share", "upgrade"],
  lock_waits_total: ["exclusive", "record_get", "share", "upgrade"]
};

const operationFieldOrder: Record<string, string[]> = {
  database_table_operations_total: ["create", "read", "update", "delete"],
  table_operations_total: ["create", "read", "update", "delete", "os_read"],
  index_operations_total: ["create", "read", "delete", "block_delete", "split", "os_read"],
  bi_io_operations_total: ["read", "write"],
  lock_requests_total: ["exclusive", "record_get", "share", "upgrade"],
  lock_grants_total: ["exclusive", "record_get", "share", "upgrade"],
  lock_waits_total: ["exclusive", "record_get", "share", "upgrade"]
};

export function isOpenEdgeDbCollectorSnapshot(input: unknown): input is CollectorSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    (value.protocolVersion === 2 || value.protocolVersion === 3 || value.protocolVersion === 4) &&
    !!value.database &&
    typeof value.database === "object" &&
    !!value.snapshot &&
    typeof value.snapshot === "object" &&
    !Array.isArray(value.snapshot)
  );
}

/** Converts the private ABL VST snapshot into the validated native v2 payload. */
export function normalizeOpenEdgeDbCollectorSnapshot(
  input: CollectorSnapshot
): OpenEdgeDbObserverPayload {
  if (input.labels && input.protocolVersion !== 4)
    setOpenEdgeDbLabelSet({
      tables:
        input.protocolVersion === 2
          ? (input.labels.tables ?? []).slice(0, OPENEDGE_DB_LABEL_TABLE_LIMIT)
          : (input.labels.tables ?? []),
      indexes: input.labels.indexes ?? []
    });
  if (
    input.protocolVersion >= 3 &&
    (!input.labels || !Array.isArray(input.labels.tables) || !Array.isArray(input.labels.indexes))
  )
    throw new Error("openedge_db_observer_contract_invalid:labels");
  const labelSet: OpenEdgeDbLabelSet =
    input.protocolVersion === 4
      ? {
          tables: [...input.labels!.tables!, "other"],
          indexes: [...input.labels!.indexes!, "other"]
        }
      : openEdgeDbLabelSet();
  const indexed = indexSnapshot(input.snapshot);
  const status = input.snapshot._DbStatus?.[0];
  const timezoneReset = getRecordValue(status, "_DbStatus-ZeroStatsDate-TZ");
  const fallbackReset = getRecordValue(status, "_DbStatus-ZeroStatsDate");
  const statisticsResetAt = selectOpenEdgeStatisticsResetTimestamp(
    timezoneReset == null ? input.database.statisticsResetAt : String(timezoneReset),
    fallbackReset == null ? input.database.statisticsResetAt : String(fallbackReset)
  );
  const productVersion = String(
    getRecordValue(status, "_DbStatus-OEVersion") ?? input.database.productVersion
  ).trim();
  const database = {
    productVersion,
    startedAt: String(
      getRecordValue(status, "_DbStatus-starttime") ?? input.database.startedAt
    ).trim(),
    statisticsResetAt
  };
  let latchInventory: OpenEdgeDbLatchInventory | undefined;
  if (input.protocolVersion === 4) {
    const rows = input.snapshot._Latch;
    const declared = input.latchInventory;
    const fail = (): never => {
      throw new Error("openedge_db_observer_contract_invalid:latch_inventory");
    };
    const validText = (v: unknown): v is string =>
      typeof v === "string" && !!v.trim() && v.length <= 256;
    if (
      !validText(input.database.name) ||
      !declared ||
      declared.complete !== true ||
      declared.authoritativePublisher !== "endpoint" ||
      !validText(declared.runId) ||
      !Array.isArray(rows) ||
      !rows.length ||
      rows.length > 512 ||
      declared.count !== rows.length
    )
      fail();
    const ids = new Set<string>();
    const instances = rows.map((row) => {
      const name = row["_Latch-Name"],
        type = row["_Latch-Type"],
        id = row.latch_id;
      const wait = row["_Latch-Wait"],
        duration = row["_Latch-WaitT"];
      if (
        !validText(name) ||
        !validText(type) ||
        !validText(id) ||
        ids.has(id) ||
        !Number.isSafeInteger(wait) ||
        Number(wait) < 0 ||
        (duration !== undefined && (!Number.isSafeInteger(duration) || Number(duration) < 0))
      )
        fail();
      ids.add(id as string);
      return {
        latch_name: name as string,
        latch_type: type as string,
        latch_id: id as string,
        availability: "available" as const
      };
    });
    latchInventory = {
      runId: declared!.runId,
      database: input.database.name!,
      databaseEpoch: databaseEpoch(database.startedAt, database.statisticsResetAt),
      capturedAt: input.collectedAt,
      authoritativePublisher: "endpoint",
      complete: true,
      instances
    };
    labelSet.latches = instances;
    labelSet.database = input.database.name;
  }
  const payload: OpenEdgeDbObserverPayload = {
    protocolVersion: input.protocolVersion as 2 | 3 | 4,
    ...(latchInventory ? { latchInventory } : {}),
    ...(input.protocolVersion >= 3
      ? { labels: { tables: input.labels!.tables!, indexes: input.labels!.indexes! } }
      : {}),
    database: {
      ...database,
      ...(input.protocolVersion === 4 ? { name: input.database.name! } : {})
    },
    collectedAt: input.collectedAt,
    families: OPENEDGE_DB_FAMILY_NAMES.map((name) => ({
      name,
      sources: [...OPENEDGE_DB_FAMILY_SOURCES[name]],
      measurements: []
    })),
    metrics: []
  } as OpenEdgeDbObserverPayload;
  const familyByName = new Map(payload.families.map((family) => [family.name, family]));
  const missingSources = new Set(input.unavailableSources ?? []);
  for (const definition of OPENEDGE_DB_METRIC_CATALOG.filter(
    (d) => (d.sinceProtocol ?? 2) <= input.protocolVersion
  )) {
    const family = familyByName.get(definition.family)!;
    for (const labels of getOpenEdgeDbAvailabilityTuples(definition, labelSet)) {
      let collected: CollectedValue;
      if (definition.sinceProtocol === 4) {
        const row = input.snapshot._Latch.find((r) => r.latch_id === labels.latch_id)!;
        const field =
          definition.name === "latch_named_waits_total" ? "_Latch-Wait" : "_Latch-WaitT";
        const raw = row[field];
        collected =
          raw === undefined
            ? { source: "_Latch", availability: "unsupported", reason: "field_missing" }
            : {
                source: "_Latch",
                availability: "available",
                reason: "available",
                value: Number(raw) / (field === "_Latch-WaitT" ? 1000000 : 1)
              };
      } else collected = collectValue(definition, labels, indexed, missingSources);
      family.measurements.push({
        name: definition.name,
        availability: collected.availability,
        source: collected.source,
        reason: collected.reason,
        ...(Object.keys(labels).length ? { labels } : {})
      });
      if (collected.availability === "available" && collected.value !== undefined) {
        const metricLabels: Record<string, string> = { ...labels };
        if (definition.dimensions.includes("database_epoch"))
          metricLabels.database_epoch = databaseEpoch(
            database.startedAt,
            database.statisticsResetAt
          );
        const metric: OpenEdgeDbObserverMetric = {
          name: definition.name,
          type: definition.type,
          unit: definition.unit,
          value: collected.value,
          source: collected.source,
          labels: metricLabels
        };
        payload.metrics.push(metric);
      }
    }
  }
  return payload;
}

function collectValue(
  definition: OpenEdgeDbMetricDefinition,
  labels: Record<string, string>,
  indexed: IndexedSnapshot,
  missingSources: Set<string>
): CollectedValue {
  const { snapshot, params } = indexed;
  const paramSource = "_DbParams";
  const sourceFields = definition.sourceFields;
  const fieldForOperation = operationField(definition, labels.operation);
  const defaultField = fieldForOperation ?? sourceFields[0];
  let source =
    definition.name === "buffer_pool_configured_buffers" ||
    definition.name === "recovery_log_threshold_bytes"
      ? paramSource
      : (sourceFromField(defaultField) ?? definition.sources[0]);
  if (
    definition.name === "transaction_active_count" ||
    definition.name === "transaction_oldest_active_age_seconds"
  )
    source = "_Trans";
  if (definition.name === "bi_buffered_io_enabled") source = "_Logging";
  if (definition.name === "buffer_pool_cumulative_cache_hit_ratio") source = "_ActBuffer";

  const unavailable = (
    availability: OpenEdgeDbAvailability,
    reason: OpenEdgeDbAvailabilityReason
  ): CollectedValue => ({ source, availability, reason });
  if (missingSources.has(source)) return unavailable("unsupported", "vst_missing");

  // _ActBuffer counts reserved primary buffers too. Use the observed allocation,
  // never infer capacity from occupancy or clamp over-capacity observations.
  const poolCapacity = () => {
    const configured = params.get(labels.pool === "alternate" ? "-B2" : "-B");
    if (labels.pool === "alternate" || !snapshot._BuffStatus?.length)
      return { value: configured, source: paramSource, invalid: false };
    const alternate = params.get("-B2");
    const totals = snapshot._BuffStatus.map((row) =>
      numeric(getRecordValue(row, "_BfStatus-TotBufs"))
    );
    const total = totals[0];
    if (total === undefined) return { value: configured, source: paramSource, invalid: false };
    const valid =
      configured !== undefined &&
      alternate !== undefined &&
      Number.isSafeInteger(total) &&
      Number.isSafeInteger(configured) &&
      Number.isSafeInteger(alternate) &&
      alternate >= 0 &&
      total >= configured + alternate &&
      total <= configured + alternate + 2 &&
      totals.every((value) => value === total);
    return {
      value: valid ? total - alternate! : undefined,
      source: "_BuffStatus",
      invalid: !valid
    };
  };

  if (definition.name === "buffer_pool_configured_buffers") {
    const pool = labels.pool;
    const capacity = poolCapacity();
    if (capacity.invalid) return unavailable("temporarily_unavailable", "collection_error");
    const value = capacity.value;
    if (value === undefined) return unavailable("unsupported", "field_missing");
    if (pool === "alternate" && value === 0)
      return unavailable("not_configured", "alternate_pool_disabled");
    return available(capacity.source, value);
  }

  if (
    definition.name === "buffer_pool_free_buffers" ||
    definition.name === "buffer_pool_active_buffers"
  ) {
    if (missingSources.has("_DbParams")) return unavailable("unsupported", "vst_missing");
    const allocation = poolCapacity();
    if (allocation.invalid) return unavailable("temporarily_unavailable", "collection_error");
    const capacity = allocation.value;
    if (capacity === undefined) return unavailable("unsupported", "field_missing");
    if (labels.pool === "alternate" && capacity === 0)
      return unavailable("not_configured", "alternate_pool_disabled");
    const rows = indexed.byDimension.get(JSON.stringify(["_ActBuffer", "pool", labels.pool])) ?? [];
    if (!rows.length) return absentRow(definition, "_ActBuffer", missingSources);
    const values = rows.map((row) => numeric(getRecordValue(row, "_Buffer-Active")));
    const active = values[0];
    if (active === undefined) return unavailable("unsupported", "field_missing");
    if (
      capacity <= 0 ||
      !Number.isInteger(capacity) ||
      active < 0 ||
      active > capacity ||
      values.some((value) => value !== active)
    )
      return unavailable("temporarily_unavailable", "collection_error");
    return available(
      "_ActBuffer",
      definition.name === "buffer_pool_free_buffers" ? capacity - active : active
    );
  }

  if (definition.name === "recovery_log_threshold_bytes") {
    const value = params.get("-bithold");
    return value === undefined
      ? unavailable("unsupported", "field_missing")
      : available(source, value * 1_048_576);
  }

  if (labels.pool === "alternate" && source === "_ActBuffer" && params.get("-B2") === 0)
    return unavailable("not_configured", "alternate_pool_disabled");

  if (definition.name === "transaction_active_count") {
    if (missingSources.has("_Trans")) return unavailable("unsupported", "vst_missing");
    if (!snapshot._Trans) return unavailable("temporarily_unavailable", "collection_error");
    return available("_Trans", snapshot._Trans.length);
  }
  if (definition.name === "transaction_oldest_active_age_seconds") {
    if (missingSources.has("_Trans")) return unavailable("unsupported", "vst_missing");
    const durations = (snapshot._Trans ?? [])
      .map((row) => numeric(getRecordValue(row, "_Trans-Duration")))
      .filter((value): value is number => value !== undefined);
    return durations.length
      ? available("_Trans", Math.max(...durations))
      : unavailable("not_collected", "not_applicable");
  }

  if (definition.name === "buffer_pool_cumulative_cache_hit_ratio") {
    const rows = indexed.byDimension.get(JSON.stringify(["_ActBuffer", "pool", labels.pool])) ?? [];
    const row = rows[0];
    if (!row) return absentRow(definition, source, missingSources);
    const logical = numeric(getRecordValue(row, "_Buffer-LogicRds"));
    const disk = numeric(getRecordValue(row, "_Buffer-OSRds"));
    if (logical === undefined || disk === undefined)
      return unavailable("unsupported", "field_missing");
    if (logical <= 0) return unavailable("not_collected", "not_applicable");
    if (
      disk < 0 ||
      disk > logical ||
      rows.some(
        (other) =>
          numeric(getRecordValue(other, "_Buffer-LogicRds")) !== logical ||
          numeric(getRecordValue(other, "_Buffer-OSRds")) !== disk
      )
    )
      return unavailable("temporarily_unavailable", "collection_error");
    return available(source, (logical - disk) / logical);
  }

  if (
    definition.name === "bi_file_size_bytes" ||
    definition.name === "bi_cluster_size_bytes" ||
    definition.name === "bi_cluster_count"
  ) {
    const status = snapshot._DbStatus?.[0];
    if (!status) return absentRow(definition, "_DbStatus", missingSources);
    const biSize = numeric(getRecordValue(status, "_DbStatus-BiSize"));
    const blockSize = numeric(getRecordValue(status, "_DbStatus-BiBlkSize"));
    const clusterSize = numeric(getRecordValue(status, "_DbStatus-BiClSize"));
    if (definition.name === "bi_file_size_bytes")
      return biSize === undefined || blockSize === undefined
        ? unavailable("unsupported", "field_missing")
        : available("_DbStatus", biSize * blockSize);
    if (definition.name === "bi_cluster_size_bytes")
      return clusterSize === undefined
        ? unavailable("unsupported", "field_missing")
        : available("_DbStatus", clusterSize * 1024);
    if (biSize === undefined || blockSize === undefined || clusterSize === undefined)
      return unavailable("unsupported", "field_missing");
    if (clusterSize <= 0) return unavailable("temporarily_unavailable", "collection_error");
    const count = (biSize * blockSize) / (clusterSize * 1024);
    return Number.isInteger(count)
      ? available("_DbStatus", count)
      : unavailable("not_collected", "not_applicable");
  }

  if (definition.name === "bi_buffered_io_enabled") {
    const value = getRecordValue(snapshot._Logging?.[0], "_Logging-BiIO");
    if (value === undefined) return absentRow(definition, "_Logging", missingSources);
    if (value === "BUFFERED") return available("_Logging", 1);
    if (value === "Reliable") return available("_Logging", 0);
    return unavailable("not_collected", "not_applicable");
  }

  const field = fieldForOperation ?? sourceFields[0];
  if (!field) return unavailable("temporarily_unavailable", "collection_error");
  source = sourceFromField(field) ?? source;
  if (missingSources.has(source)) return unavailable("unsupported", "vst_missing");

  const records = snapshot[source];
  if (!records) return unavailable("temporarily_unavailable", "collection_error");
  if (source === "_Checkpoint" && records.length === 0)
    return unavailable("not_collected", "not_applicable");
  const fieldName = fieldNameFromReference(field);
  if (!indexed.fields.get(source)?.has(fieldName.toLowerCase()))
    return unavailable("unsupported", "field_missing");

  if (
    definition.name === "checkpoint_last_duration_seconds" ||
    definition.name === "checkpoint_last_bi_write_duration_seconds" ||
    definition.name === "checkpoint_last_database_write_duration_seconds" ||
    definition.name === "checkpoint_last_sync_duration_seconds" ||
    definition.name === "checkpoint_last_buffers" ||
    definition.name === "checkpoint_last_dirty_buffers" ||
    definition.name === "checkpoint_last_flushed_buffers" ||
    definition.name === "checkpoint_last_apw_queue_buffers" ||
    definition.name === "checkpoint_last_checkpoint_queue_buffers" ||
    definition.name === "checkpoint_last_apw_scan_buffers"
  ) {
    const latest = [...records].sort(
      (left, right) =>
        (numeric(getRecordValue(right, "_Checkpoint-Number")) ?? -1) -
        (numeric(getRecordValue(left, "_Checkpoint-Number")) ?? -1)
    )[0];
    if (!latest) return unavailable("not_collected", "not_applicable");
    const value = numeric(getRecordValue(latest, fieldName));
    return value === undefined
      ? unavailable("unsupported", "field_missing")
      : available(source, value);
  }

  let selected = records;
  if (labels.pool)
    selected = indexed.byDimension.get(JSON.stringify([source, "pool", labels.pool])) ?? [];
  if (labels.table)
    selected = indexed.byDimension.get(JSON.stringify([source, "table", labels.table])) ?? [];
  if (labels.index)
    selected = indexed.byDimension.get(JSON.stringify([source, "index", labels.index])) ?? [];
  if (selected.length === 0) {
    if (labels.table || labels.index)
      return unavailable("not_configured", "statistics_range_excludes_object");
    if (labels.pool) return unavailable("temporarily_unavailable", "collection_error");
    return unavailable("temporarily_unavailable", "collection_error");
  }
  const values = selected
    .map((row) => numeric(getRecordValue(row, fieldName)))
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return unavailable("unsupported", "field_missing");
  if (definition.name === "apw_uptime_seconds") return available(source, Math.max(...values));
  if (
    definition.name === "latch_lock_duration_seconds_total" ||
    definition.name === "latch_wait_or_spin_duration_seconds_total"
  )
    return available(source, values.reduce((sum, value) => sum + value, 0) / 1_000_000);
  if (definition.family === "latch" || labels.table || labels.index || definition.family === "apw")
    return available(
      source,
      values.reduce((sum, value) => sum + value, 0)
    );
  return available(source, values[0]);
}

interface IndexedSnapshot {
  snapshot: Record<string, SnapshotRecord[]>;
  params: Map<string, number | undefined>;
  byDimension: Map<string, SnapshotRecord[]>;
  fields: Map<string, Set<string>>;
}
function indexSnapshot(raw: Record<string, SnapshotRecord[]>): IndexedSnapshot {
  const result: IndexedSnapshot = {
    snapshot: {},
    params: new Map(),
    byDimension: new Map(),
    fields: new Map()
  };
  for (const [source, rows] of Object.entries(raw)) {
    if (!Array.isArray(rows))
      throw new Error("openedge_db_observer_contract_invalid:snapshot_rows");
    const fields = new Set<string>();
    result.fields.set(source, fields);
    result.snapshot[source] = rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error("openedge_db_observer_contract_invalid:snapshot_row");
      const normalized = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
      );
      for (const key of Object.keys(normalized)) fields.add(key);
      for (const dimension of ["table", "index", "pool"]) {
        if (normalized[dimension] === undefined) continue;
        const key = JSON.stringify([source, dimension, normalized[dimension]]);
        const group = result.byDimension.get(key) ?? [];
        group.push(normalized);
        result.byDimension.set(key, group);
      }
      return normalized;
    });
  }
  for (const row of result.snapshot._DbParams ?? []) {
    const name = String(row.parameter ?? ""),
      value = numeric(getRecordValue(row, "_DbParams-Value"));
    if (result.params.has(name) && result.params.get(name) !== value)
      result.params.set(name, undefined);
    else result.params.set(name, value);
  }
  return result;
}

function operationField(
  definition: OpenEdgeDbMetricDefinition,
  operation: string | undefined
): string | undefined {
  if (!operation) return undefined;
  const order = operationFieldOrder[definition.name] ?? [];
  const index = order.indexOf(operation);
  return index < 0 ? undefined : definition.sourceFields[index];
}

function sourceFromField(field: string | undefined): string | undefined {
  return field?.split(".", 1)[0];
}

function fieldNameFromReference(field: string): string {
  const separator = field.indexOf(".");
  return separator < 0 ? field : field.slice(separator + 1);
}

function getRecordValue(
  record: SnapshotRecord | undefined,
  name: string
): string | number | undefined {
  if (!record) return undefined;
  if (name.toLowerCase() in record) return record[name.toLowerCase()];
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  );
  return key ? record[key] : undefined;
}

function numeric(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const result = Number(value.trim());
  return Number.isFinite(result) ? result : undefined;
}

function available(source: string, value: number): CollectedValue {
  return { source, value, availability: "available", reason: "available" };
}

function absentRow(
  definition: OpenEdgeDbMetricDefinition,
  source: string,
  missingSources: Set<string>
): CollectedValue {
  if (missingSources.has(source))
    return { source, availability: "unsupported", reason: "vst_missing" };
  return { source, availability: "temporarily_unavailable", reason: "collection_error" };
}
