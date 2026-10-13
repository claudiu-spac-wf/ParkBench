import React from "react";
import {
  COMPARISON_METRIC_CATALOG,
  type ProjectedMetricValue
} from "../../../../../packages/contracts/src/comparison-metric-selection";
import { formatPercentageChange } from "./comparisonPresentation";
export function SelectedMetricTable({
  runId,
  rows
}: {
  runId: string;
  rows: ProjectedMetricValue[];
}) {
  const items = rows.filter((r) => r.runId === runId);
  return (
    <section aria-label={`Selected metrics for ${runId}`}>
      <h3>Selected measurements</h3>
      {[...new Set(items.flatMap((row) => row.warnings))].map((warning) => (
        <p key={warning} role="status" className="comparison-warning">
          Warning: {warning}
        </p>
      ))}
      {!items.length ? (
        <p>No metrics selected or available in this page.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Metric / scope</th>
              <th>Statistic</th>
              <th>Value</th>
              <th>Baseline / difference</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const descriptor = COMPARISON_METRIC_CATALOG.find((d) => d.metricId === row.metricId),
                percentage = row.difference.percentageDifference,
                direction = descriptor?.improvementDirection ?? "unknown";
              const tone =
                percentage === null || percentage === 0 || direction === "unknown"
                  ? "neutral"
                  : percentage > 0 === (direction === "higher")
                    ? "improvement"
                    : "deterioration";
              return (
                <tr key={row.rowId}>
                  <th>
                    {descriptor?.displayName ?? row.metricId}
                    <br />
                    <small>
                      {Object.entries(row.dimensions)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ")}
                    </small>
                  </th>
                  <td>{row.statistic}</td>
                  <td>
                    <strong>
                      {row.value === null
                        ? "—"
                        : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 7 }).format(
                            row.value
                          )}{" "}
                      {row.unit}
                    </strong>
                    <br />
                    <small>
                      {row.availability}; {row.reasons.join(", ")}
                      {row.coverage
                        ? `; observed ${row.coverage.observedSeconds}s / ${row.coverage.durationSeconds}s`
                        : ""}
                    </small>
                  </td>
                  <td>
                    {row.baseline && (
                      <>
                        Baseline: {row.baseline.value ?? "—"} {row.unit}
                        <br />
                      </>
                    )}
                    {percentage !== null && (
                      <span
                        className={`status ${tone === "improvement" ? "succeeded" : tone === "deterioration" ? "failed" : "neutral"}`}
                        data-tone={tone}
                        aria-label={`Change from baseline: ${formatPercentageChange(percentage)}`}
                      >
                        {formatPercentageChange(percentage)}
                      </span>
                    )}
                    {percentage === null && row.difference.reason !== "baseline_row" && (
                      <small>
                        Difference unavailable: {row.difference.reason?.replaceAll("_", " ")}
                      </small>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
