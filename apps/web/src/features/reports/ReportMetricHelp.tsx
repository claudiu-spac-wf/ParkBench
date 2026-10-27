import React from "react";
import { FieldHelp } from "../../shared/FieldHelp";
import { ReportColumn } from "../../../../../packages/contracts/src/database-analysis-report";
import { REPORT_RULES } from "../../../../../packages/contracts/src/database-analysis-definitions";
export function ReportMetricHelp({
  column,
  guideHref
}: {
  column: ReportColumn;
  guideHref?: string;
}) {
  return (
    <FieldHelp label={column.sourceHeader}>
      {column.description} Native column: {column.sourceHeader}. Unit:{" "}
      {column.unit ?? "not specified"}.{" "}
      {column.unit === "bytes"
        ? "Size labels are rounded; numeric filters use exact bytes. "
        : column.unit === "%"
          ? "Numeric filters use the percentage without the % sign. "
          : ""}
      {REPORT_RULES.filter((rule) => rule.metric === column.sourceHeader).map((rule) => (
        <span key={rule.id} className="report-metric-methodology">
          {rule.explanation} Source: {rule.source}.{" "}
        </span>
      ))}
      <a href={guideHref ?? "#reports/help"}>Read the report guide</a>
    </FieldHelp>
  );
}
