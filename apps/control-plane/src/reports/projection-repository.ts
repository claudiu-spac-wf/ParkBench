import {
  ReportColumn,
  ReportRow,
  DatasetKind
} from "../../../../packages/contracts/src/database-analysis-report";
import { ReportRepository } from "./repository";
import { sortComponents } from "./exact-numeric";
import { findingsForRow } from "./findings";
export function storeRows(
  repo: ReportRepository,
  id: string,
  kind: DatasetKind,
  revision: string,
  rows: Array<{ row: ReportRow; columns: ReportColumn[] }>
) {
  repo.transaction(() => {
    const insert = repo.db.prepare("INSERT INTO report_rows VALUES(?,?,?,?,?,?,?,?,?)"),
      cell = repo.db.prepare("INSERT INTO report_cells VALUES(?,?,?,?,?,?,?,?,?,?)"),
      finding = repo.db.prepare("INSERT INTO report_findings VALUES(?,?,?,?,?,?,?)");
    for (const { row, columns } of rows) {
      const findings = findingsForRow(kind, row, columns);
      for (const f of findings)
        if (f.columnOrdinal >= 0) {
          row.cells[f.columnOrdinal].assessments ??= [];
          row.cells[f.columnOrdinal].assessments!.push(f);
        }
      row.concern = findings.some((f) => f.severity === "higher_concern")
        ? "higher_concern"
        : findings.some((f) => f.severity === "review")
          ? "review"
          : findings.some((f) => f.severity === "unavailable")
            ? "unavailable"
            : "none";
      insert.run(
        id,
        kind,
        revision,
        row.sourceRowOrdinal,
        row.objectKey,
        row.label,
        row.areaId,
        row.concern,
        JSON.stringify(row)
      );
      row.cells.forEach((c, i) => {
        const s = sortComponents(c.exact);
        cell.run(
          id,
          kind,
          revision,
          row.sourceRowOrdinal,
          i,
          c.availability === "AVAILABLE" ? 0 : 1,
          s.numericClass,
          s.exponent,
          s.digits,
          c.sourceText
        );
      });
      for (const f of findings.filter((f) => ["review", "higher_concern"].includes(f.severity))) {
        const retained = {
          ...f,
          id: `${kind}:${row.sourceRowOrdinal}:${f.ruleId}`,
          severity: f.severity.toUpperCase(),
          explanationKey: f.ruleId
        };
        finding.run(
          id,
          revision,
          kind,
          row.sourceRowOrdinal,
          row.objectKey,
          retained.severity,
          JSON.stringify(retained)
        );
      }
    }
  });
}
