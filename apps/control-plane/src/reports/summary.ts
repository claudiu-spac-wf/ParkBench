import { ReportRepository } from "./repository";
import {
  ReportMetadata,
  DatasetKind
} from "../../../../packages/contracts/src/database-analysis-report";
import { compareExact, sumExact } from "./exact-numeric";
export function buildSummary(repo: ReportRepository, report: ReportMetadata, revision: string) {
  const areaSources = new Map<string, string>();
  const byArea = new Map<string, string[]>(),
    byObject: Array<{
      label: string;
      value: string;
      datasetKind: string;
      sourceRowOrdinal: number;
      objectKey: string;
    }> = [],
    totals: any[] = [],
    blockCounts: any[] = [];
  for (const dataset of report.datasets) {
    if (!["AVAILABLE", "EMPTY"].includes(dataset.availability)) continue;
    const size = dataset.columns.findIndex((c) => c.sourceHeader === "Size"),
      count = dataset.columns.findIndex((c) => c.sourceHeader === "Num Blocks");
    const values: string[] = [];
    let missing = false;
    const seen = new Set<string>();
    for (const record of repo.db
      .prepare(
        "SELECT document FROM report_rows WHERE report_id=? AND kind=? AND revision=? ORDER BY ordinal"
      )
      .iterate(report.id, dataset.kind, revision) as any) {
      const row = JSON.parse(record.document);
      if (dataset.kind === "block") {
        blockCounts.push({ label: row.label, value: row.cells[count]?.exact ?? null });
        continue;
      }
      if (!["table", "index", "lob"].includes(dataset.kind)) continue;
      if (/^(?:total|subtotal|summary)(?:$|\s)/i.test(row.label.replace(/^PUB\./, ""))) {
        missing = true;
        continue;
      }
      if (seen.has(row.objectKey)) {
        missing = true;
        continue;
      }
      seen.add(row.objectKey);
      const value = row.cells[size]?.exact;
      if (value == null) {
        missing = true;
        continue;
      }
      values.push(value);
      const label = dataset.kind + ": " + row.label + " (area " + row.areaId + ")";
      byObject.push({
        label,
        value,
        datasetKind: dataset.kind,
        sourceRowOrdinal: row.sourceRowOrdinal,
        objectKey: row.objectKey
      });
      const bucket = byArea.get(row.areaId) ?? [];
      bucket.push(value);
      byArea.set(row.areaId, bucket);
      if (!areaSources.has(row.areaId)) areaSources.set(row.areaId, dataset.kind);
    }
    if (["table", "index", "lob"].includes(dataset.kind))
      totals.push({
        datasetKind: dataset.kind,
        value: sumExact(values),
        unit: "bytes",
        complete: dataset.complete && !missing
      });
  }
  function top(points: any[]) {
    points.sort((a, b) => -compareExact(a.value, b.value) || a.label.localeCompare(b.label));
    return points.length > 20
      ? [
          ...points.slice(0, 20),
          { label: "Other", value: sumExact(points.slice(20).map((p) => p.value)) }
        ]
      : points;
  }
  const objects = repo.db
    .prepare(
      "SELECT count(DISTINCT object_key) n FROM report_findings WHERE report_id=? AND revision=? AND severity IN ('REVIEW','HIGHER_CONCERN')"
    )
    .get(report.id, revision) as any;
  const findings = repo.db
    .prepare(
      "SELECT count(*) n FROM report_findings WHERE report_id=? AND revision=? AND severity IN ('REVIEW','HIGHER_CONCERN')"
    )
    .get(report.id, revision) as any;
  return {
    reportId: report.id,
    revision,
    status: report.projectionState === "UNSUPPORTED" ? "UNSUPPORTED" : "READY",
    reason:
      report.projectionState === "UNSUPPORTED"
        ? "Native columns are retained generically; this adapter cannot establish the required chart semantics."
        : undefined,
    scope: `Full report: ${report.type} collected object content bytes; not physical allocated database size.`,
    totals,
    areas: top(
      [...byArea].map(([label, values]) => ({
        label: "Area " + label,
        value: sumExact(values),
        areaId: label,
        datasetKind: areaSources.get(label)
      }))
    ),
    objects: top(byObject),
    blockCounts: top(blockCounts.filter((p) => p.value !== null)),
    coverage: report.datasets,
    concernObjectCount: String(objects.n),
    findingCount: String(findings.n)
  };
}
