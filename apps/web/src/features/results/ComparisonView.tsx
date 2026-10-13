import React, { useEffect, useState } from "react";
import { getComparison } from "./resultsApi";
import { comparisonExportUrl } from "./resultsApi";
export function ComparisonView({ experimentId }: { experimentId: string }) {
  const [data, setData] = useState();
  useEffect(() => {
    void getComparison(experimentId)
      .then(setData)
      .catch(() => undefined);
  }, [experimentId]);
  return (
    <section>
      <h2>Comparison</h2>
      <p>{experimentId}</p>
      {data && !data.comparisonAvailable && (
        <p role="status">
          No comparable baseline is available. This experiment is exploratory or its baseline did
          not produce a valid measurement.
        </p>
      )}
      <a href={comparisonExportUrl(experimentId)} download={`comparison-${experimentId}.csv`}>
        Download comparison CSV
      </a>
      {data?.baseline && <p>Baseline: {data.baseline.variantId}</p>}
      {data && (
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Variant</th>
              <th>Repetition</th>
              <th>Metric</th>
              <th>Value</th>
              <th>Baseline</th>
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            {(data.comparable ?? []).flatMap((run: any) =>
              (run.deltas ?? []).map((delta: any) => (
                <tr
                  key={`${run.runId}-${delta.metricName}-${delta.phase}-${JSON.stringify(delta.labels)}`}
                >
                  <td>{run.runId}</td>
                  <td>{run.variantId}</td>
                  <td>{run.repetition}</td>
                  <td>{delta.metricName}</td>
                  <td>{format(delta.value)}</td>
                  <td>{format(delta.baselineValue)}</td>
                  <td>{format(delta.delta)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
      {data?.nonComparable?.map((run: any) => (
        <p key={run.runId} role="status">
          {run.runId} is not comparable: {run.reason}
        </p>
      ))}
    </section>
  );
}

function format(value: unknown): string {
  return typeof value === "number" ? value.toFixed(4) : "—";
}
