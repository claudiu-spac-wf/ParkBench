import { COMPARISON_METRIC_CATALOG } from "../../../../../packages/contracts/src/comparison-metric-selection";
import type { SummaryRow } from "../../../../../packages/contracts/src/run-summary";
import type {
  ComparisonRow,
  ComparisonRunResult
} from "../../../../../packages/contracts/src/comparison";
import type { Statistic } from "../../../../../packages/contracts/src/metric-definitions";
import type { BaselineQualitySnapshot } from "./comparisonApi";

type RowIdentity = Pick<SummaryRow, "group" | "definitionId" | "dimensions">;
const resourceDefinitions: Record<string, readonly string[]> = {
  platform: ["cpu.usage", "memory.used"],
  database: ["cpu.usage", "memory.used", "disk.read.operations", "disk.write.operations"],
  pas: ["cpu.usage"]
};
const databaseDefinitions = new Set([
  "db.records.read",
  "db.records.write",
  "db.buffer.logical.read",
  "db.buffer.logical.write",
  "db.blocks.read",
  "db.blocks.write"
]);

export function isResourceRowVisible(row: RowIdentity): boolean {
  return resourceDefinitions[row.group]?.includes(row.definitionId) ?? false;
}
export function isDatabaseRowVisible(row: RowIdentity): boolean {
  return (
    row.group === "database" &&
    databaseDefinitions.has(row.definitionId) &&
    !Object.prototype.hasOwnProperty.call(row.dimensions, "table")
  );
}

export interface BaselineBadge {
  text: string;
  tone: "improvement" | "deterioration" | "neutral";
}
const percentageNumber = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
/** Intl decimal rounding uses halfway-away-from-zero; the server difference remains authoritative. */
export function formatPercentageChange(percentage: number): string {
  if (percentage === 0) return "↔ 0%";
  const magnitude = Math.abs(percentage);
  const formatted = magnitude < 0.01 ? "<0.01" : percentageNumber.format(magnitude);
  return `${percentage > 0 ? "↑ +" : "↓ -"}${formatted}%`;
}

function completeRun(run?: ComparisonRunResult): boolean {
  return (
    run?.state === "SUCCEEDED" &&
    run.measurementValidity === "VALID" &&
    run.summary?.status === "READY" &&
    run.summary.header?.quality?.complete === true
  );
}
const dimensionsIdentity = (dimensions: Record<string, string>) =>
  JSON.stringify(Object.entries(dimensions).sort(([left], [right]) => left.localeCompare(right)));

/** Gate each original statistic without calculating or matching a second comparison delta. */
export function baselineBadge({
  comparisonRow,
  statistic,
  run,
  baselineQuality
}: {
  comparisonRow: ComparisonRow;
  statistic: Statistic;
  run?: ComparisonRunResult;
  baselineQuality?: BaselineQualitySnapshot;
}): { badge?: BaselineBadge; reason?: string; warning?: string } {
  if (run?.role === "BASELINE") return {};
  const { row, baselineRow, differences } = comparisonRow;
  const difference = differences[statistic];
  if (difference?.reason)
    return difference.reason === "baseline_row" ? {} : { reason: difference.reason };
  if (baselineQuality?.status !== "accepted" && baselineQuality?.sourceStatus !== "stable")
    return {
      reason:
        baselineQuality?.reason ?? "Baseline quality is pending or unavailable. Retry comparison."
    };
  if (baselineQuality?.run?.runId !== baselineQuality?.baselineRunId)
    return { reason: "Baseline source identity does not match the selected run." };
  if (
    run?.summary.status !== "READY" ||
    !run.summary.attemptToken ||
    !run.summary.header?.generatedAt ||
    !run.summary.header?.metricDefinitionsVersion ||
    baselineQuality?.run?.summary.status !== "READY"
  )
    return { reason: "Compared measurement source identity is unavailable. Retry comparison." };
  const warning =
    [
      !completeRun(baselineQuality?.run)
        ? "Baseline measurements are incomplete or ineligible for comparison."
        : undefined,
      !completeRun(run)
        ? "Run measurements are incomplete or ineligible for comparison."
        : undefined
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const value = row.statistics[statistic],
    baseline = baselineRow?.statistics[statistic];
  if (
    !value ||
    !baseline ||
    value.value === null ||
    baseline.value === null ||
    !Number.isFinite(value.value) ||
    !Number.isFinite(baseline.value) ||
    value.status === "unavailable" ||
    baseline.status === "unavailable"
  )
    return { reason: "Compared measurement or baseline statistic is unavailable." };
  if (baseline.value === 0) return { reason: "Baseline value is zero." };
  if (
    row.rowKey !== baselineRow.rowKey ||
    row.definitionId !== baselineRow.definitionId ||
    row.group !== baselineRow.group ||
    row.coverageScope !== baselineRow.coverageScope ||
    row.rateOrLevelUnit !== baselineRow.rateOrLevelUnit ||
    row.totalUnit !== baselineRow.totalUnit ||
    dimensionsIdentity(row.dimensions) !== dimensionsIdentity(baselineRow.dimensions) ||
    value.unit !== baseline.unit
  )
    return { reason: "Compared measurement and baseline semantics do not match." };
  if (
    !difference ||
    typeof difference.percentageDifference !== "number" ||
    !Number.isFinite(difference.percentageDifference)
  )
    return { reason: "Percentage difference is unavailable." };
  const descriptor = COMPARISON_METRIC_CATALOG.find(
    (d) => d.definitionId === row.definitionId && d.group === row.group
  );
  const direction = descriptor?.improvementDirection ?? "unknown";
  const percentage = difference.percentageDifference;
  const higherIsBetter = direction === "higher";
  return {
    warning,
    badge: {
      text: formatPercentageChange(percentage),
      tone:
        percentage === 0 || direction === "unknown"
          ? "neutral"
          : percentage > 0 === higherIsBetter
            ? "improvement"
            : "deterioration"
    }
  };
}

export type ParameterSource = "Ordinary parameters" | "Database startup";
export interface ScheduledParameterEntry {
  name: string;
  value: string;
  sources: ParameterSource[];
  provenance?: string;
}
export interface ScheduledParameters {
  entries: ScheduledParameterEntry[];
  status: "populated" | "empty" | "partial" | "unavailable";
  unavailableSources: ParameterSource[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const owns = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Project retained schedule-time values only; never patch partial snapshots from fallbacks. */
export function projectScheduledParameters(environmentSnapshot: unknown): ScheduledParameters {
  const snapshot = record(environmentSnapshot) ? environmentSnapshot : {};
  const preferred = owns(snapshot, "requestedConfiguration");
  const configuration = record(snapshot.requestedConfiguration)
    ? snapshot.requestedConfiguration
    : {};
  const variant = record(snapshot.variant) ? snapshot.variant : {};
  const ordinary = preferred ? configuration.parameters : variant.parameters;
  const startup = preferred
    ? configuration.databaseStartup
    : owns(snapshot, "databaseStartup")
      ? snapshot.databaseStartup
      : variant.databaseStartup;
  const entries: ScheduledParameterEntry[] = [];
  const unavailableSources: ParameterSource[] = [];
  const add = (name: string, value: string, source: ParameterSource) => {
    const existing = entries.find((entry) => entry.name === name && entry.value === value);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else entries.push({ name, value, sources: [source] });
  };

  let ordinaryUnavailable = !record(ordinary);
  if (record(ordinary))
    for (const [name, value] of Object.entries(ordinary)) {
      let displayed: string | undefined;
      try {
        displayed = typeof value === "string" ? value : JSON.stringify(value);
      } catch {
        /* Keep the other retained entries when a malformed value cannot be displayed. */
      }
      if (!name || displayed === undefined) ordinaryUnavailable = true;
      else add(name, displayed, "Ordinary parameters");
    }
  const controls = preferred ? configuration.databaseRunControls : variant.databaseRunControls;
  if (controls !== undefined) {
    if (
      !record(controls) ||
      controls.contractVersion !== "db-run-controls.v1" ||
      !Number.isInteger(controls.apwCount) ||
      typeof controls.biwEnabled !== "boolean" ||
      !record(controls.biCluster)
    )
      ordinaryUnavailable = true;
    else {
      const values: Record<string, string> = {
        "database.apwCount": String(controls.apwCount),
        "database.biwEnabled": String(controls.biwEnabled),
        "database.biClusterSizeMiB":
          controls.biCluster.mode === "inherit"
            ? "Inherited from seed"
            : `${controls.biCluster.requestedMiB} MiB`
      };
      for (const [name, value] of Object.entries(values)) {
        const existing = entries.find((entry) => entry.name === name);
        if (!existing) add(name, value, "Ordinary parameters");
        const entry = entries.find((entry) => entry.name === name)!;
        const field = name.slice("database.".length);
        if (record(controls.sources) && typeof controls.sources[field] === "string")
          entry.provenance = controls.sources[field] as string;
      }
    }
  }
  if (ordinaryUnavailable) unavailableSources.push("Ordinary parameters");

  let startupUnavailable = !record(startup);
  if (record(startup) && Object.keys(startup).length > 0) {
    if (!Array.isArray(startup.parameters)) startupUnavailable = true;
    else
      for (const entry of startup.parameters) {
        if (
          !record(entry) ||
          typeof entry.name !== "string" ||
          !entry.name ||
          typeof entry.displayValue !== "string"
        )
          startupUnavailable = true;
        else add(entry.name, entry.displayValue, "Database startup");
      }
  }
  if (startupUnavailable) unavailableSources.push("Database startup");

  return {
    entries,
    status:
      unavailableSources.length > 0
        ? entries.length > 0
          ? "partial"
          : "unavailable"
        : entries.length > 0
          ? "populated"
          : "empty",
    unavailableSources
  };
}
