import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
  REPORT_VERSIONS,
  ReportRow,
  ReportColumn
} from "../../../../packages/contracts/src/database-analysis-report";
import { ReportRepository } from "./repository";
import { ReportArtifacts } from "./artifacts";
import { reportDownload } from "./downloads";
import { csvRecords } from "./csv";
import { projectedRow, exactNativeNumber } from "./native-parser";
import { storeRows } from "./projection-repository";
import { buildSummary } from "./summary";
import { ReportMetadata } from "../../../../packages/contracts/src/database-analysis-report";

function correctedColumns(kind: string, columns: ReportColumn[]): ReportColumn[] {
  return columns.map((column) =>
    kind === "lob" && ["Min", "Max", "Mean"].includes(column.sourceHeader)
      ? { ...column, type: "decimal" }
      : column
  );
}
/** Detect this known projection bug without touching a seed or altering source evidence. */
export function needsNativeNumberRepair(repo: ReportRepository, report: ReportMetadata): boolean {
  if (!report.projectionRevision) return false;
  const columns = new Map(
    report.datasets.map((d) => [d.kind, correctedColumns(d.kind, d.columns)])
  );
  if (
    report.datasets.some(
      (d) =>
        d.kind === "lob" &&
        d.csvArtifactId &&
        d.rowCount !== "0" &&
        d.columns.some((c, i) => c.type !== columns.get(d.kind)![i].type)
    )
  )
    return true;
  const candidates = repo.db.prepare(
    "SELECT kind,column_id,text_value FROM report_cells WHERE report_id=? AND revision=? AND availability=1"
  );
  for (const cell of candidates.iterate(report.id, report.projectionRevision) as any) {
    const column = columns.get(cell.kind)?.[cell.column_id];
    if (!column || column.type === "text") continue;
    const trimmed = cell.text_value.trim();
    if (
      exactNativeNumber(cell.text_value, column.type) !== null ||
      (trimmed !== cell.text_value && ["", "?"].includes(trimmed))
    )
      return true;
  }
  return false;
}
/** Rebuild only from retained CSV with captured mappings, never from a current seed. */
export async function rebuildRetainedProjection(
  repo: ReportRepository,
  artifacts: ReportArtifacts,
  id: string
) {
  const report = repo.get(id);
  if (!report) throw new Error("report_not_found");
  if (
    report.columnsVersion !== REPORT_VERSIONS.columnsVersion ||
    report.rulesVersion !== REPORT_VERSIONS.rulesVersion ||
    report.csvVersion !== REPORT_VERSIONS.csvVersion ||
    report.parserVersion !== REPORT_VERSIONS.parserVersion
  )
    throw new Error("report_definitions_version_unavailable");
  const repair = needsNativeNumberRepair(repo, report);
  const revision = randomUUID();
  try {
    for (const dataset of report.datasets) {
      if (!dataset.csvArtifactId) continue;
      const { stream } = reportDownload(artifacts, id, dataset.csvArtifactId);
      dataset.columns = correctedColumns(dataset.kind, dataset.columns);
      let ordinal = 0,
        header = true,
        batch: Array<{ row: ReportRow; columns: ReportColumn[] }> = [];
      for await (const values of csvRecords(stream)) {
        if (header) {
          if (JSON.stringify(values) !== JSON.stringify(dataset.columns.map((c) => c.csvHeader)))
            throw new Error("report_output_invalid");
          header = false;
          continue;
        }
        if (values.length !== dataset.columns.length) throw new Error("report_output_invalid");
        batch.push({
          row: projectedRow(dataset.columns, values, ++ordinal),
          columns: dataset.columns
        });
        if (batch.length >= 64) {
          storeRows(repo, id, dataset.kind, revision, batch);
          batch = [];
          await setImmediate();
        }
      }
      if (header || String(ordinal) !== dataset.rowCount) throw new Error("report_output_invalid");
      if (batch.length) storeRows(repo, id, dataset.kind, revision, batch);
    }
    const summary = buildSummary(repo, report, revision);
    repo.transaction(() => {
      repo.db
        .prepare("INSERT INTO report_summaries VALUES(?,?,?)")
        .run(id, revision, JSON.stringify(summary));
      report.projectionRevision = revision;
      for (const dataset of report.datasets) repo.dataset(report.id, dataset);
      if (repair)
        report.warnings = [
          ...report.warnings.filter(
            (w) =>
              w.code !== "report_projection_repaired" &&
              w.code !== "report_projection_repair_failed"
          ),
          {
            code: "report_projection_repaired",
            message: "Report measurements corrected for native number formatting.",
            correctiveAction:
              "Review the updated measurements and findings; original CSV remains available."
          }
        ];
      repo.save(report);
    });
    return revision;
  } catch (error) {
    repo.transaction(() => {
      for (const table of ["report_rows", "report_cells", "report_findings", "report_summaries"])
        repo.db.prepare(`DELETE FROM ${table} WHERE report_id=? AND revision=?`).run(id, revision);
    });
    throw error;
  }
}
