import type { DatabaseParameterSnapshot } from "../../../contracts/src/database-parameter-snapshot";
import { OPENEDGE_DB_PARAMETER_MAX_METRIC_VALUE_BYTES } from "../../../contracts/src/openedge-db-parameter-capture";
import type { MetricSample } from "../../../contracts/src/metrics";
import { observerLabels, ObserverContext } from "../adapter";

const PREFIX = "parkbench_openedge_db_parameter_snapshot_";

export function parameterSnapshotSamples(
  snapshot: DatabaseParameterSnapshot,
  context: ObserverContext,
  timestamp = Date.now() / 1000
): MetricSample[] {
  const labels = { ...observerLabels(context, "database", "database"), database_name: snapshot.databaseName };
  const base = (suffix: string, value: number, extra: Record<string, string> = {}): MetricSample => ({
    metricName: `${PREFIX}${suffix}`,
    type: "gauge",
    labels: { ...labels, ...extra },
    timestamp,
    value,
    source: "_DbParams"
  });
  const samples = [
    base("status", 1, { state: snapshot.status }),
    base("rows", snapshot.rowCount)
  ];
  if (snapshot.capturedAt) samples.push(base("timestamp_seconds", Date.parse(snapshot.capturedAt) / 1000));
  for (const row of snapshot.rows) {
    if (row.displayValue !== null && Buffer.byteLength(row.displayValue) > OPENEDGE_DB_PARAMETER_MAX_METRIC_VALUE_BYTES)
      continue;
    samples.push(base("info", 1, {
      parameter: row.name,
      display_value: row.displayValue ?? "",
      value_status: row.valueStatus
    }));
    if (row.numericValue !== undefined)
      samples.push(base("numeric", row.numericValue, { parameter: row.name }));
  }
  return samples;
}

export function formatParameterSnapshotMetrics(snapshot: DatabaseParameterSnapshot): string {
  const samples = parameterSnapshotSamples(snapshot, {
    runId: "", experimentId: "", variantId: "", repetition: 1, phase: "idle"
  });
  const types = new Set(samples.map((sample) => sample.metricName));
  const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r");
  return [
    ...[...types].map((name) => `# TYPE ${name} gauge`),
    ...samples.map((sample) => {
      const labels = Object.entries(sample.labels).filter(([name]) =>
        ["database_name", "parameter", "display_value", "value_status", "state"].includes(name));
      return `${sample.metricName}{${labels.map(([name, value]) => `${name}="${escape(value ?? "")}"`).join(",")}} ${sample.value}`;
    })
  ].join("\n") + "\n";
}
