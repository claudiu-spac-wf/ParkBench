import {
  ReportColumn,
  ReportRow,
  DatasetKind
} from "../../../../packages/contracts/src/database-analysis-report";
import { REPORT_RULES } from "../../../../packages/contracts/src/database-analysis-definitions";
import { compareExact } from "./exact-numeric";
export interface ReportFinding {
  ruleId: string;
  rulesVersion: string;
  datasetKind: DatasetKind;
  sourceRowOrdinal: number;
  objectKey: string;
  columnOrdinal: number;
  observed: string | null;
  boundary: string;
  severity: "review" | "higher_concern" | "none" | "unavailable" | "not_assessed";
  source: string;
  explanation: string;
}
export function findingsForRow(
  kind: DatasetKind,
  row: ReportRow,
  columns: ReportColumn[]
): ReportFinding[] {
  return REPORT_RULES.filter((rule) => rule.dataset === kind).map((rule) => {
    const columnOrdinal = columns.findIndex((c) => c.sourceHeader === rule.metric),
      minimumColumn = columns.findIndex((c) => c.sourceHeader === rule.minimumColumn),
      observed = row.cells[columnOrdinal]?.exact ?? null,
      minimum = row.cells[minimumColumn]?.exact ?? null;
    let severity: ReportFinding["severity"] = "none";
    if (observed === null || minimum === null) severity = "unavailable";
    else if (compareExact(minimum, rule.minimum) < 0) severity = "not_assessed";
    else if (rule.direction === "high")
      severity =
        compareExact(observed, rule.higher) >= 0
          ? "higher_concern"
          : compareExact(observed, rule.review) >= 0
            ? "review"
            : "none";
    else
      severity =
        compareExact(observed, rule.higher) < 0
          ? "higher_concern"
          : compareExact(observed, rule.review) < 0
            ? "review"
            : "none";
    return {
      ruleId: rule.id,
      rulesVersion: "database-analysis-rules.v1",
      datasetKind: kind,
      sourceRowOrdinal: row.sourceRowOrdinal,
      objectKey: row.objectKey,
      columnOrdinal,
      observed,
      boundary: severity === "higher_concern" ? rule.higher : rule.review,
      severity,
      source: rule.source,
      explanation: rule.explanation
    };
  });
}
