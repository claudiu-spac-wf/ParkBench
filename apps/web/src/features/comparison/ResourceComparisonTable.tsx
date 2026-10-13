import React from "react";
import type {
  ComparisonRow,
  ComparisonRunResult
} from "../../../../../packages/contracts/src/comparison";
import { isResourceRowVisible, baselineBadge } from "./comparisonPresentation";
import type { BaselineQualitySnapshot } from "./comparisonApi";
const units: Record<string, string> = {
  percent_one_core: "% of one core",
  cpu_seconds: "CPU seconds",
  bytes: "bytes",
  bytes_per_second: "bytes/s",
  records: "records",
  records_per_second: "records/s",
  operations: "operations",
  operations_per_second: "operations/s",
  blocks: "blocks",
  blocks_per_second: "blocks/s",
  transactions: "transactions",
  transactions_per_second: "transactions/s"
};
const number = (value: number | null | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 7 }).format(value);
export function MetricRows({
  rows,
  caption,
  run,
  baselineQuality
}: {
  rows: ComparisonRow[];
  caption: string;
  run?: ComparisonRunResult;
  baselineQuality?: BaselineQualitySnapshot;
  key?: string;
}) {
  const warnings = [
    ...new Set(
      rows.flatMap((comparisonRow) =>
        ["average", "p90", "p95", "total"]
          .map(
            (statistic) =>
              baselineBadge({ comparisonRow, statistic: statistic as any, run, baselineQuality })
                .warning
          )
          .filter((value): value is string => !!value)
      )
    )
  ];
  return (
    <table>
      <caption>
        {caption}
        {warnings.map((warning) => (
          <small key={warning} className="comparison-warning" role="status">
            Warning: {warning}
          </small>
        ))}
      </caption>
      <thead>
        <tr>
          <th scope="col">Metric / scope</th>
          <th scope="col">Average</th>
          <th scope="col">p90</th>
          <th scope="col">p95</th>
          <th scope="col">Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((comparisonRow) => {
          const { row, baselineRow } = comparisonRow;
          return (
            <tr key={row.rowKey}>
              <th scope="row">
                {row.displayName}
                <br />
                <small>
                  {row.coverageScope}{" "}
                  {Object.entries(row.dimensions)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(" · ")}
                </small>
              </th>
              {(["average", "p90", "p95", "total"] as const).map((key) => {
                const s = row.statistics[key],
                  b = baselineRow?.statistics[key];
                const change = baselineBadge({
                  comparisonRow,
                  statistic: key,
                  run,
                  baselineQuality
                });
                return (
                  <td key={key}>
                    {s ? (
                      <>
                        <strong>
                          {number(s.value)} {units[s.unit] ?? s.unit}
                        </strong>
                        {change.badge && (
                          <>
                            {" "}
                            <span
                              className={`status ${change.badge.tone === "improvement" ? "succeeded" : change.badge.tone === "deterioration" ? "failed" : "neutral"}`}
                              data-tone={change.badge.tone}
                              aria-label={`Change from baseline: ${change.badge.text}`}
                            >
                              {change.badge.text}
                            </span>
                          </>
                        )}
                        <br />
                        <small>
                          {s.status}; observed {number(s.coverage.observedSeconds)}s /{" "}
                          {number(s.coverage.durationSeconds)}s
                          {s.coverage.estimatedEdgeSeconds > 0
                            ? `; estimated edge ${number(s.coverage.estimatedEdgeSeconds)}s`
                            : ""}
                        </small>
                        {s.reasons.length > 0 && <div>{s.reasons.join(", ")}</div>}
                        {b && (
                          <div>
                            Baseline: {number(b.value)} {units[b.unit] ?? b.unit}
                          </div>
                        )}
                        {change.reason && (
                          <small>
                            Difference unavailable: {change.reason.replaceAll("_", " ")}
                          </small>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
export function ResourceComparisonTable({
  run,
  baselineQuality
}: {
  run: ComparisonRunResult;
  baselineQuality?: BaselineQualitySnapshot;
}) {
  const rows = run.rows.filter((r) => isResourceRowVisible(r.row));
  return (
    <section aria-label={`Resources for ${run.runId}`}>
      <h3>Resources</h3>
      {(["platform", "database", "pas"] as const).map((group) => {
        const items = rows.filter((r) => r.row.group === group);
        return items.length ? (
          <MetricRows
            key={group}
            rows={items}
            run={run}
            baselineQuality={baselineQuality}
            caption={`${group[0].toUpperCase() + group.slice(1)} resources`}
          />
        ) : null;
      })}
      {!rows.length && (
        <p>
          Resource measurements are {run.summary.status.toLowerCase()}:{" "}
          {run.summary.reason?.replaceAll("_", " ") ?? "not collected"}.
        </p>
      )}
    </section>
  );
}
