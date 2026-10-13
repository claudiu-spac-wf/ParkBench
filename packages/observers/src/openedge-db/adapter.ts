import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MetricSample, MetricType } from "../../../contracts/src/metrics";
import {
  OPENEDGE_DB_METRIC_CATALOG,
  openEdgeDbLabelSet,
  OpenEdgeDbObserverPayloadV2,
  OpenEdgeDbObserverPayload,
  OpenEdgeDbObserverPayloadV3,
  validateOpenEdgeDbObserverPayload,
  databaseEpoch,
  validateOpenEdgeDbObserverPayloadV2
} from "../../../contracts/src/openedge";
import { ObserverAdapter, ObserverContext, observerLabels } from "../adapter";
import {
  OpenEdgeDbParameterCapture,
  validateOpenEdgeDbParameterCapture
} from "../../../contracts/src/openedge-db-parameter-capture";
import { assertAllowedDatabaseMetric } from "./allowlist";
import { isOpenEdgeDbCollectorSnapshot, normalizeOpenEdgeDbCollectorSnapshot } from "./snapshot";

const execFileAsync = promisify(execFile);

export function parseOpenEdgeDbParameterCaptureOutput(output: string): OpenEdgeDbParameterCapture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error("openedge_db_parameter_capture_invalid:json");
  }
  return validateOpenEdgeDbParameterCapture(parsed);
}

export async function readOpenEdgeDbParameterCapture(
  options: OpenEdgeDatabaseCommandOptions
): Promise<OpenEdgeDbParameterCapture> {
  validateOpenEdgeDatabaseCommand(options);
  const result = await execFileAsync(options.executable, [options.procedure, "parameter-capture"], {
    timeout: options.timeoutMs ?? 10_000,
    maxBuffer: 2 * 1024 * 1024
  });
  return parseOpenEdgeDbParameterCaptureOutput(result.stdout);
}

export type OpenEdgeNativeMetricType = "counter" | "gauge" | "info";
export interface OpenEdgeNativeMetric {
  value: number;
  type: OpenEdgeNativeMetricType;
  source: string;
}

export interface OpenEdgeDatabaseCommandOptions {
  executable: string;
  procedure: string;
  timeoutMs?: number;
  args?: string[];
  /** Only adapter-level test doubles may use a non-procedure launcher argument. */
  allowNonProcedure?: boolean;
  readOnly?: boolean;
}

export function validateOpenEdgeDatabaseCommand(options: OpenEdgeDatabaseCommandOptions): void {
  if (!options.executable || !options.procedure)
    throw new Error("openedge_db_observer_not_configured");
  if (options.readOnly === false) throw new Error("openedge_db_observer_read_only_required");
  if (!/^[A-Za-z0-9_./\\:-]+$/.test(options.executable))
    throw new Error("openedge_db_observer_executable_invalid");
  if (
    !options.allowNonProcedure &&
    (!/\.(?:p|r)$/i.test(options.procedure) ||
      !/^(?:parkbench-db-observer(?:-v2)?\.(?:p|r)|prepare-run-db-observer\.p)$/i.test(
        path.basename(options.procedure)
      ))
  )
    throw new Error("openedge_db_observer_procedure_not_approved");
  if (
    (options.executable.includes("/") || options.executable.includes("\\")) &&
    (!fs.existsSync(options.executable) || !fs.statSync(options.executable).isFile())
  )
    throw new Error("openedge_db_observer_executable_missing");
  if (
    (options.procedure.includes("/") || options.procedure.includes("\\")) &&
    ![
      "/app/openedge/observers/db/parkbench-db-observer.p",
      "/app/openedge/observers/db/parkbench-db-observer.r",
      "/app/openedge/observers/db/parkbench-db-observer-v2.p",
      "/app/openedge/observers/db/parkbench-db-observer-v2.r",
      "/app/openedge/observers/db/prepare-run-db-observer.p"
    ].includes(options.procedure) &&
    (!fs.existsSync(options.procedure) || !fs.statSync(options.procedure).isFile())
  )
    throw new Error("openedge_db_observer_procedure_missing");
}

export class OpenEdgeDatabaseObserver implements ObserverAdapter {
  id = "openedge-db";
  kind = "openedge_db_v1";
  constructor(
    private readonly sampleFn: (metric: string) => Promise<number | OpenEdgeNativeMetric>,
    private readonly metrics = ["_DbStatus"],
    private readonly readyFn: () => Promise<boolean> = async () => true
  ) {
    metrics.forEach(assertAllowedDatabaseMetric);
  }
  async ready(): Promise<boolean> {
    return this.readyFn();
  }
  async sample(context: ObserverContext): Promise<MetricSample[]> {
    return Promise.all(
      this.metrics.map(async (metric) => {
        const value = await finiteSample(this.sampleFn(metric), metric);
        return {
          metricName: `parkbench_openedge_db_${metric.slice(1).toLowerCase()}`,
          type: value.type,
          labels: observerLabels(context, "observer", "database"),
          timestamp: Date.now() / 1000,
          value: value.value,
          source: value.source
        };
      })
    );
  }
}

export function commandDatabaseObserver(
  metrics: string[],
  options: OpenEdgeDatabaseCommandOptions
): OpenEdgeDatabaseObserver {
  const read = () => readOpenEdgeVstMetrics(options);
  return new OpenEdgeDatabaseObserver(
    async (metric) => {
      const values = await read();
      const value = values[metric] ?? values[metric.replace(/^_/, "")];
      if (value === undefined) throw new Error(`openedge_metric_missing:${metric}`);
      return value;
    },
    metrics,
    async () => {
      try {
        const values = await read();
        return metrics.every(
          (metric) => values[metric] !== undefined || values[metric.replace(/^_/, "")] !== undefined
        );
      } catch {
        return false;
      }
    }
  );
}

export async function readOpenEdgeVstMetrics(
  options: OpenEdgeDatabaseCommandOptions
): Promise<Record<string, OpenEdgeNativeMetric>> {
  validateOpenEdgeDatabaseCommand(options);
  const result = await execFileAsync(
    options.executable,
    [options.procedure, ...(options.args ?? [])],
    {
      timeout: options.timeoutMs ?? 5000,
      maxBuffer: 1024 * 1024
    }
  );
  return parseOpenEdgeVstOutput(result.stdout);
}

export class OpenEdgeDatabaseObserverV2 implements ObserverAdapter {
  id = "openedge-db";
  /** Public observer contract remains v1; only the native ABL payload is v2. */
  kind = "openedge_db_v1";

  constructor(
    private readonly payloadFn: () => Promise<OpenEdgeDbObserverPayloadV2>,
    private readonly readyFn: () => Promise<boolean> = async () => true
  ) {}

  async ready(): Promise<boolean> {
    return this.readyFn();
  }

  async sample(context: ObserverContext): Promise<MetricSample[]> {
    const payload = validateOpenEdgeDbObserverPayloadV2(await this.payloadFn());
    const timestamp = Date.parse(payload.collectedAt) / 1000;
    const contextLabels = observerLabels(context, "observer", "database");
    const availability: MetricSample[] = payload.families.flatMap((family) =>
      family.measurements.map((measurement) => ({
        metricName: "parkbench_openedge_db_metric_available",
        type: "gauge" as MetricType,
        labels: {
          ...contextLabels,
          family: family.name,
          measurement: measurement.name,
          reason: measurement.reason,
          ...(measurement.labels ?? {})
        },
        timestamp,
        value: measurement.availability === "available" ? 1 : 0,
        source: measurement.source
      }))
    );
    const metrics = payload.metrics.map((metric) => ({
      metricName: `parkbench_openedge_db_${metric.name}`,
      type: metric.type,
      labels: { ...contextLabels, ...metric.labels },
      timestamp,
      value: metric.value,
      source: metric.source
    }));
    return [...availability, ...metrics];
  }
}

export function commandDatabaseObserverV2(
  options: OpenEdgeDatabaseCommandOptions
): OpenEdgeDatabaseObserverV2 {
  const read = () => readOpenEdgeDbObserverPayloadV2(options);
  return new OpenEdgeDatabaseObserverV2(read, async () => {
    try {
      await read();
      return true;
    } catch {
      return false;
    }
  });
}

export async function readOpenEdgeDbObserverPayloadV2(
  options: OpenEdgeDatabaseCommandOptions
): Promise<OpenEdgeDbObserverPayloadV2> {
  validateOpenEdgeDatabaseCommand(options);
  const result = await execFileAsync(
    options.executable,
    [options.procedure, ...(options.args ?? [])],
    { timeout: options.timeoutMs ?? 5000, maxBuffer: 4 * 1024 * 1024 }
  );
  return parseOpenEdgeDbObserverV2Output(result.stdout);
}

export function parseOpenEdgeDbObserverV2Output(output: string): OpenEdgeDbObserverPayloadV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error("openedge_db_observer_contract_invalid:json");
  }
  if ((parsed as any)?.protocolVersion !== 2)
    throw new Error("openedge_db_observer_contract_invalid:protocol");
  const normalized = isOpenEdgeDbCollectorSnapshot(parsed)
    ? normalizeOpenEdgeDbCollectorSnapshot(parsed)
    : aggregateUnknownOpenEdgeObjects(parsed);
  return validateOpenEdgeDbObserverPayloadV2(addDatabaseEpochLabels(normalized));
}

export function parseOpenEdgeDbObserverOutput(output: string): OpenEdgeDbObserverPayload {
  if (Buffer.byteLength(output) > 8 * 1024 * 1024)
    throw new Error("openedge_db_observer_contract_invalid:collection_bytes_exceeded");
  let parsed: any;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error("openedge_db_observer_contract_invalid:json");
  }
  if (parsed.protocolVersion !== 2 && parsed.protocolVersion !== 3 && parsed.protocolVersion !== 4)
    throw new Error("openedge_db_observer_contract_invalid:protocol");
  const normalized = isOpenEdgeDbCollectorSnapshot(parsed)
    ? normalizeOpenEdgeDbCollectorSnapshot(parsed)
    : parsed.protocolVersion === 2
      ? aggregateUnknownOpenEdgeObjects(parsed)
      : parsed;
  return validateOpenEdgeDbObserverPayload(
    parsed.protocolVersion === 4 ? normalized : addDatabaseEpochLabels(normalized)
  );
}
export async function readOpenEdgeDbObserverPayload(
  options: OpenEdgeDatabaseCommandOptions
): Promise<OpenEdgeDbObserverPayload> {
  validateOpenEdgeDatabaseCommand(options);
  const result = await execFileAsync(
    options.executable,
    [options.procedure, ...(options.args ?? [])],
    { timeout: options.timeoutMs ?? 5000, maxBuffer: 8 * 1024 * 1024 }
  ).catch((error: unknown) => {
    const stdout = String((error as { stdout?: unknown }).stdout ?? "");
    if (/\((?:748|1154)\)/.test(stdout) && /\(19489\)/.test(stdout))
      throw new Error("openedge_db_observer_connection_capacity_exhausted:review_-n_-Ma_-Mn");
    throw error;
  });
  return parseOpenEdgeDbObserverOutput(result.stdout);
}
export class OpenEdgeDatabaseObserverV3 implements ObserverAdapter {
  id = "openedge-db";
  kind = "openedge_db_v1";
  constructor(
    private readonly payloadFn: () => Promise<OpenEdgeDbObserverPayload>,
    private readonly readyFn: () => Promise<boolean> = async () => true
  ) {}
  async latchInventory(context: ObserverContext) {
    const payload = validateOpenEdgeDbObserverPayload(await this.payloadFn());
    if (payload.protocolVersion !== 4 || payload.latchInventory.runId !== context.runId)
      throw new Error("named_latch_evidence_missing:inventory_owner");
    return payload.latchInventory;
  }
  async ready() {
    return this.readyFn();
  }
  async sample(context: ObserverContext): Promise<MetricSample[]> {
    const payload = validateOpenEdgeDbObserverPayload(await this.payloadFn()),
      timestamp = Date.parse(payload.collectedAt) / 1000,
      labels = observerLabels(context, "observer", "database");
    if (payload.protocolVersion === 4 && payload.latchInventory.runId !== context.runId)
      throw new Error("openedge_db_observer_contract_invalid:inventory_owner");
    const inventorySamples: MetricSample[] =
      payload.protocolVersion === 4
        ? (() => {
            const inventory = payload.latchInventory;
            const identity = {
              ...labels,
              database: inventory.database,
              database_epoch: inventory.databaseEpoch
            };
            return [
              {
                metricName: "parkbench_openedge_db_latch_inventory_complete",
                type: "gauge" as const,
                labels: identity,
                timestamp,
                value: 1,
                source: "_Latch"
              },
              {
                metricName: "parkbench_openedge_db_latch_inventory_instances",
                type: "gauge" as const,
                labels: identity,
                timestamp,
                value: inventory.instances.length,
                source: "_Latch"
              },
              ...inventory.instances.map(({ availability, ...instance }) => ({
                metricName: "parkbench_openedge_db_latch_inventory_info",
                type: "gauge" as const,
                labels: { ...identity, ...instance },
                timestamp,
                value: 1,
                source: "_Latch"
              }))
            ];
          })()
        : [];
    return [
      ...inventorySamples,
      ...payload.families.flatMap((family) =>
        family.measurements.map((m) => ({
          metricName: "parkbench_openedge_db_metric_available",
          type: "gauge" as const,
          labels: {
            ...labels,
            family: family.name,
            measurement: m.name,
            reason: m.reason,
            ...m.labels,
            ...(payload.protocolVersion === 4 && m.name.startsWith("latch_named_")
              ? { database_epoch: payload.latchInventory.databaseEpoch }
              : {})
          },
          timestamp,
          value: m.availability === "available" ? 1 : 0,
          source: m.source
        }))
      ),
      ...payload.metrics.map((m) => ({
        metricName: `parkbench_openedge_db_${m.name}`,
        type: m.type,
        labels: { ...labels, ...m.labels },
        timestamp,
        value: m.value,
        source: m.source
      }))
    ];
  }
}
export function commandDatabaseObserverV3(options: OpenEdgeDatabaseCommandOptions) {
  const read = () => readOpenEdgeDbObserverPayload(options);
  return new OpenEdgeDatabaseObserverV3(read, async () => {
    try {
      await read();
      return true;
    } catch {
      return false;
    }
  });
}

function addDatabaseEpochLabels(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const payload = structuredClone(input) as Record<string, any>;
  if (!payload.database || !Array.isArray(payload.metrics)) return payload;
  const epoch = databaseEpoch(payload.database.startedAt, payload.database.statisticsResetAt);
  const definitions = new Map(OPENEDGE_DB_METRIC_CATALOG.map((d) => [d.name, d]));
  for (const metric of payload.metrics) {
    const definition = definitions.get(metric.name);
    if (
      definition &&
      (definition.type === "counter" ||
        definition.name === "buffer_pool_cumulative_cache_hit_ratio")
    ) {
      metric.labels = { ...(metric.labels ?? {}), database_epoch: epoch };
    }
  }
  return payload;
}

function aggregateUnknownOpenEdgeObjects(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const payload = structuredClone(input) as Record<string, any>;
  if (!Array.isArray(payload.families) || !Array.isArray(payload.metrics)) return payload;
  const labelSet = openEdgeDbLabelSet();
  const tableAllowlist = new Set<string>(labelSet.tables);
  const indexAllowlist = new Set<string>(labelSet.indexes);
  const normalize = (labels: Record<string, string> | undefined): boolean => {
    if (!labels) return false;
    let changed = false;
    if (labels.table && !tableAllowlist.has(labels.table)) {
      labels.table = "other";
      changed = true;
    }
    if (labels.index && !indexAllowlist.has(labels.index)) {
      labels.index = "other";
      changed = true;
    }
    return changed;
  };

  for (const family of payload.families) {
    if (!Array.isArray(family.measurements)) continue;
    const normalized = family.measurements.map((measurement: any) => ({
      measurement,
      collapsed: normalize(measurement.labels)
    }));
    const grouped = new Map<string, typeof normalized>();
    for (const item of normalized) {
      const key = seriesKey(item.measurement.name, item.measurement.labels ?? {});
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    family.measurements = [...grouped.values()].map((items) => {
      const first = items[0].measurement;
      if (items.length === 1) return first;
      if (
        items.every(
          (item) =>
            item.measurement.availability === first.availability &&
            item.measurement.reason === first.reason &&
            item.measurement.source === first.source
        )
      )
        return first;
      return {
        ...first,
        availability: "temporarily_unavailable",
        reason: "collection_error"
      };
    });
  }

  const normalizedMetrics = payload.metrics.map((metric: any) => ({
    metric,
    collapsed: normalize(metric.labels)
  }));
  const metricGroups = new Map<string, typeof normalizedMetrics>();
  for (const item of normalizedMetrics) {
    const key = seriesKey(item.metric.name, item.metric.labels ?? {});
    metricGroups.set(key, [...(metricGroups.get(key) ?? []), item]);
  }
  const availability = new Map<string, any>();
  for (const family of payload.families) {
    for (const measurement of family.measurements) {
      availability.set(seriesKey(measurement.name, measurement.labels ?? {}), measurement);
    }
  }
  payload.metrics = [...metricGroups.entries()].flatMap(([key, items]) => {
    if (items.length === 1) return items.map((item) => item.metric);
    if (!items.some((item) => item.collapsed)) return items.map((item) => item.metric);
    const total = items.reduce((sum, item) => sum + Number(item.metric.value), 0);
    const combined = { ...items[0].metric, value: total };
    const tupleLabels = Object.fromEntries(
      Object.entries(combined.labels).filter(([label]) => label !== "database_epoch")
    ) as Record<string, string>;
    const tupleKey = seriesKey(combined.name, tupleLabels);
    return availability.get(tupleKey)?.availability === "available" ? [combined] : [];
  });
  return payload;
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const sortedLabels = Object.fromEntries(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))
  );
  return `${name}:${JSON.stringify(sortedLabels)}`;
}

export function parseOpenEdgeVstOutput(output: string): Record<string, OpenEdgeNativeMetric> {
  const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
  const entries: Array<[string, unknown]> = Array.isArray(parsed.metrics)
    ? parsed.metrics.map((entry): [string, unknown] => {
        if (!entry || typeof entry !== "object")
          throw new Error("openedge_db_observer_malformed_output");
        const item = entry as Record<string, unknown>;
        return [String(item.name ?? ""), item];
      })
    : Object.entries(parsed).filter(([name]) => name !== "observerVersion");
  const values: Record<string, OpenEdgeNativeMetric> = {};
  for (const [name, raw] of entries) {
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error("openedge_db_observer_metric_name_invalid");
    const item = raw && typeof raw === "object" ? raw : { value: raw };
    if (!item || typeof item !== "object")
      throw new Error(`openedge_db_observer_metric_invalid:${name}`);
    const rawValue = (item as Record<string, unknown>).value ?? raw;
    const value =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string" && /^[-+]?\d+(?:\.\d+)?$/.test(rawValue.trim())
          ? Number(rawValue)
          : Number.NaN;
    if (!Number.isFinite(value)) throw new Error(`openedge_db_observer_metric_non_numeric:${name}`);
    const type = (item as Record<string, unknown>).type ?? "gauge";
    if (!["counter", "gauge", "info"].includes(String(type)))
      throw new Error(`openedge_db_observer_metric_type_invalid:${name}`);
    const source = String((item as Record<string, unknown>).source ?? `openedge-vst:${name}`);
    if (source.length > 200 || /[\r\n]/.test(source))
      throw new Error(`openedge_db_observer_source_invalid:${name}`);
    values[name] = { value, type: type as OpenEdgeNativeMetricType, source };
  }
  if (!Object.keys(values).length) throw new Error("openedge_db_observer_malformed_output");
  return values;
}

async function finiteSample(
  value: Promise<number | OpenEdgeNativeMetric>,
  metric: string
): Promise<OpenEdgeNativeMetric> {
  const result = await value;
  if (typeof result === "number") {
    if (!Number.isFinite(result)) throw new Error(`invalid_openedge_sample:${metric}`);
    return { value: result, type: "gauge", source: `openedge-vst:${metric}` };
  }
  if (!Number.isFinite(result.value)) throw new Error(`invalid_openedge_sample:${metric}`);
  return result;
}
