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
import { projectedRow } from "./native-parser";
import { storeRows } from "./projection-repository";
import { buildSummary } from "./summary";
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
  const revision = randomUUID();
  for (const dataset of report.datasets) {
    if (!dataset.csvArtifactId) continue;
    const { stream } = reportDownload(artifacts, id, dataset.csvArtifactId);
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
    repo.save(report);
  });
  return revision;
}
