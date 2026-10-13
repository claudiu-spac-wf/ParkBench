import React from "react";
import type { ComparisonRunResult } from "../../../../../packages/contracts/src/comparison";
import { MetricRows } from "./ResourceComparisonTable";
import { isDatabaseRowVisible } from "./comparisonPresentation";
import type { BaselineQualitySnapshot } from "./comparisonApi";

export function DatabaseComparisonTable({
  run,
  baselineQuality
}: {
  run: ComparisonRunResult;
  comparisonId: string;
  baselineQuality?: BaselineQualitySnapshot;
}) {
  return (
    <section aria-label={`Database for ${run.runId}`}>
      <h3>Database activity</h3>
      <p>Database-native and table-covered activity have independent coverage.</p>
      <MetricRows
        rows={run.rows.filter((r) => isDatabaseRowVisible(r.row))}
        run={run}
        baselineQuality={baselineQuality}
        caption="Database totals and rates"
      />
      <p>Additional database and table measurements remain available in the full saved summary.</p>
    </section>
  );
}
