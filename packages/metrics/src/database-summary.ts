import type { MetricSample } from "../../contracts/src/metrics";
import type { SummaryRow, SummaryReason } from "../../contracts/src/metric-definitions";
import { DATABASE_SUMMARY_CATALOG, DatabaseMetricDefinition } from "./summary-catalog";
import { MeasurementSeries, MeasurementStatisticsAccumulator } from "./measurement-statistics";
import {
  calculateSummaryRow,
  summaryRowFromStatistics,
  unavailableSummaryRow,
  metricSeries,
  MeasurementBuildOptions,
  acquireMetric,
  quotePromLabel
} from "./measurement-summary";
import type { PrometheusClient } from "./prometheus-client";
export interface DatabaseInventory {
  protocolVersion: 2 | 3 | 4;
  tables: string[];
  availability?: Array<{ table: string; operation: string; availability: string; reason: string }>;
}
export interface DatabaseSummaryInput {
  samples: MetricSample[];
  inventory: DatabaseInventory;
  window: { start: number; end: number };
  cadenceSeconds: number;
}
const operations = ["read", "create", "update", "delete", "write"] as const;
const tableDefinition = (id: string) =>
  DATABASE_SUMMARY_CATALOG.find((d) => d.definitionId === id)!;
function constituents(
  samples: MetricSample[],
  definition: DatabaseMetricDefinition,
  cadence: number
): MeasurementSeries[] {
  const operationsToRead =
    definition.definitionId.endsWith(".write") &&
    definition.sourceMetricNames[0].endsWith("table_operations_total")
      ? ["create", "update", "delete"]
      : [definition.selectorDimensions.operation];
  return operationsToRead.flatMap((operation) => {
    const selected = samples.filter(
      (s) =>
        s.metricName === definition.sourceMetricNames[0] &&
        Object.entries(definition.selectorDimensions).every(
          ([key, value]) => s.labels[key] === value
        ) &&
        (operation === undefined || s.labels.operation === operation)
    );
    return selected.length
      ? metricSeries(selected, cadence)
      : [{ cadenceSeconds: cadence, observations: [] }];
  });
}
export class DatabaseSummaryBuilder {
  private readonly aggregates = new Map<string, MeasurementStatisticsAccumulator>();
  constructor(
    private readonly inventory: DatabaseInventory,
    private readonly window: { start: number; end: number },
    private readonly cadence: number
  ) {
    for (const operation of operations) {
      const d = tableDefinition(`db.tables.aggregate.${operation}`);
      this.aggregates.set(
        operation,
        new MeasurementStatisticsAccumulator(window, {
          type: "counter",
          allowExactEnd: true,
          unit: d.rateOrLevelUnit,
          totalUnit: d.totalUnit!,
          constituentSelector: {
            definitionIds: [`db.table.${operation}`],
            group: "database",
            coverageScope: "table_covered"
          }
        })
      );
    }
  }
  tableRows(table: string, samples: MetricSample[]): SummaryRow[] {
    return operations.map((operation) => {
      const d = tableDefinition(`db.table.${operation}`),
        dimensions = { ...d.selectorDimensions, table },
        series = constituents(samples, d, this.cadence);
      for (const source of series) this.aggregates.get(operation)!.add(source);
      const row = calculateSummaryRow(d, dimensions, series, this.window);
      const statuses = this.inventory.availability?.filter(
        (a) =>
          a.table === table &&
          (operation === "write"
            ? ["create", "update", "delete"].includes(a.operation)
            : a.operation === operation)
      );
      for (const status of statuses ?? [])
        if (status.availability !== "available") {
          row.sourceReferences.push({
            metric: d.sourceMetricNames[0],
            source: status.reason,
            contractVersion: `openedge-db.v${this.inventory.protocolVersion}`
          });
          const reason: SummaryReason =
            status.availability === "not_configured"
              ? "not_configured"
              : status.availability === "unsupported"
                ? "unsupported"
                : "not_collected";
          row.coverage.reasons = [...new Set([...row.coverage.reasons, reason])];
          for (const statistic of Object.values(row.statistics))
            if (statistic.value === null)
              statistic.reasons = [...new Set([...statistic.reasons, reason])];
        }
      for (const reference of row.sourceReferences)
        reference.contractVersion = `openedge-db.v${this.inventory.protocolVersion}`;
      return row;
    });
  }
  aggregateRows(): SummaryRow[] {
    return operations.map((operation) => {
      const d = tableDefinition(`db.tables.aggregate.${operation}`);
      const row = summaryRowFromStatistics(
        d,
        { ...d.selectorDimensions },
        this.aggregates.get(operation)!.finish()
      );
      for (const r of row.sourceReferences)
        r.contractVersion = `openedge-db.v${this.inventory.protocolVersion}`;
      return row;
    });
  }
}
export function databaseNativeRows(
  samples: MetricSample[],
  window: { start: number; end: number },
  cadence: number
): SummaryRow[] {
  return DATABASE_SUMMARY_CATALOG.filter(
    (d) => !d.definitionId.startsWith("db.table.") && !d.definitionId.startsWith("db.tables.")
  ).map((d) =>
    calculateSummaryRow(d, { ...d.selectorDimensions }, constituents(samples, d, cadence), window)
  );
}
export function databaseSummaryRows(input: DatabaseSummaryInput): SummaryRow[] {
  const { samples, inventory, window, cadenceSeconds } = input,
    names = [
      ...new Set([
        ...inventory.tables,
        ...samples
          .filter(
            (s) =>
              s.metricName === "parkbench_openedge_db_table_operations_total" &&
              s.labels.table === "other"
          )
          .map(() => "other")
      ])
    ].sort();
  const builder = new DatabaseSummaryBuilder(inventory, window, cadenceSeconds),
    rows = databaseNativeRows(samples, window, cadenceSeconds);
  const indexed = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    const name = sample.labels.table;
    if (!name) continue;
    const group = indexed.get(name) ?? [];
    group.push(sample);
    indexed.set(name, group);
  }
  for (const name of names) rows.push(...builder.tableRows(name, indexed.get(name) ?? []));
  rows.push(...builder.aggregateRows());
  return rows;
}
/** Twelve tables x five rows keeps fewer than 64 calculation rows live. */
export async function* buildDatabaseSummaryRows(
  client: PrometheusClient,
  options: MeasurementBuildOptions,
  inventory: DatabaseInventory
): AsyncGenerator<SummaryRow> {
  const cadence = options.nativeStepSeconds ?? options.sourceStepSeconds,
    window = {
      start: Date.parse(options.window.start ?? "") / 1000,
      end: Date.parse(options.window.end ?? "") / 1000
    };
  const scope = `job="parkbench-runs",run_id=${quotePromLabel(options.run.id)}`;
  if (
    options.window.state === "not_started" ||
    !options.window.start ||
    !options.window.end ||
    options.window.durationSeconds <= 0
  ) {
    for (const d of DATABASE_SUMMARY_CATALOG.filter((d) => !d.definitionId.startsWith("db.table.")))
      yield unavailableSummaryRow(
        d,
        { ...d.selectorDimensions },
        0,
        cadence,
        options.window.state === "not_started"
          ? "measurement_not_started"
          : !options.window.start || !options.window.end
            ? "measurement_boundaries_missing"
            : "insufficient_data"
      );
    return;
  }
  for (const d of DATABASE_SUMMARY_CATALOG.filter(
    (d) => !d.definitionId.startsWith("db.table.") && !d.definitionId.startsWith("db.tables.")
  )) {
    const labels = Object.entries(d.selectorDimensions)
      .map(([key, value]) => `,${key}=${quotePromLabel(value)}`)
      .join("");
    const selector = `${d.sourceMetricNames[0]}{${scope}${labels}${d.definitionId === "db.records.write" ? ',operation=~"create|update|delete"' : ""}}`;
    try {
      const samples = await acquireMetric(client, selector, options, cadence, true);
      yield calculateSummaryRow(
        d,
        { ...d.selectorDimensions },
        constituents(samples, d, cadence),
        window
      );
    } catch (error) {
      yield unavailableSummaryRow(
        d,
        { ...d.selectorDimensions },
        options.window.durationSeconds,
        cadence,
        String(error).includes("summary_limit_exceeded")
          ? "summary_limit_exceeded"
          : String(error).includes("query_timeout")
            ? "query_timeout"
            : "source_unavailable"
      );
    }
  }
  const names = [...new Set(inventory.tables)].sort(),
    builder = new DatabaseSummaryBuilder(inventory, window, cadence);
  for (let offset = 0; offset < names.length; offset += 12) {
    options.signal?.throwIfAborted();
    const batch = names.slice(offset, offset + 12),
      pattern = batch.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    let samples: MetricSample[] = [],
      failure: SummaryReason | undefined;
    try {
      samples = await acquireMetric(
        client,
        `parkbench_openedge_db_table_operations_total{${scope},table=~${quotePromLabel(pattern)},operation=~"read|create|update|delete"}`,
        options,
        cadence,
        true
      );
    } catch (error) {
      failure = String(error).includes("summary_limit_exceeded")
        ? "summary_limit_exceeded"
        : String(error).includes("query_timeout")
          ? "query_timeout"
          : "source_unavailable";
      /* Retain named missing rows; healthy batches remain usable. */
    }
    for (const table of batch)
      for (const row of builder.tableRows(
        table,
        samples.filter((s) => s.labels.table === table)
      )) {
        if (failure) {
          row.coverage.reasons = [...new Set([...row.coverage.reasons, failure])];
          for (const stat of Object.values(row.statistics))
            stat.reasons = [...new Set([...stat.reasons, failure])];
        }
        yield row;
      }
  }
  for (const row of builder.aggregateRows()) yield row;
}
