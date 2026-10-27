import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
  COVERAGE,
  NATIVE_SUFFIX
} from "../../../../packages/contracts/src/database-analysis-definitions";
import {
  DATASET_KINDS,
  ReportMetadata,
  ReportRow,
  ReportColumn
} from "../../../../packages/contracts/src/database-analysis-report";
import { ReportRepository } from "./repository";
import { ReportArtifacts } from "./artifacts";
import { parseNative } from "./native-parser";
import { storeRows } from "./projection-repository";
import { buildSummary } from "./summary";
export async function finalizeOutput(
  repo: ReportRepository,
  storage: ReportArtifacts,
  report: ReportMetadata,
  nativeComplete: boolean
) {
  const revision = randomUUID(),
    dir = storage.directory(report.id);
  let firstError: Error | undefined;
  for (const kind of DATASET_KINDS) {
    if (!COVERAGE[report.type].includes(kind)) {
      repo.dataset(report.id, {
        kind,
        availability: "NOT_COLLECTED",
        reason: "Not collected by this report type",
        complete: true,
        rowCount: "0",
        columns: []
      });
      continue;
    }
    const file = path.join(dir, "raw", "report" + NATIVE_SUFFIX[kind]);
    if (!fs.existsSync(file)) {
      repo.dataset(report.id, {
        kind,
        availability: "MISSING",
        reason: "Expected native file absent; no verified exemption",
        complete: false,
        rowCount: "0",
        columns: []
      });
      firstError ??= new Error("report_dataset_missing");
      continue;
    }
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
      throw new Error("report_output_invalid");
    const rawStaging = path.join(dir, randomUUID() + ".tmp");
    await fs.promises.copyFile(file, rawStaging);
    const rawFd = fs.openSync(rawStaging, "r");
    try {
      fs.fsyncSync(rawFd);
    } finally {
      fs.closeSync(rawFd);
    }
    const source = storage.publishStaged(
      report.id,
      rawStaging,
      kind + "-native.txt",
      "SOURCE",
      nativeComplete,
      kind
    );
    let batch: Array<{ row: ReportRow; columns: ReportColumn[] }> = [];
    const result = await parseNative(file, kind, dir, async (row, columns) => {
      batch.push({ row, columns });
      if (batch.length >= 64) {
        storeRows(repo, report.id, kind, revision, batch);
        batch = [];
        await setImmediate();
      }
    });
    if (batch.length) storeRows(repo, report.id, kind, revision, batch);
    const complete = nativeComplete && !result.error;
    const csv = result.columns.length
      ? storage.publishStaged(
          report.id,
          result.staging,
          `${kind}${complete ? "" : "-incomplete"}.csv`,
          "CSV",
          complete,
          kind
        )
      : undefined;
    if (!csv) fs.unlinkSync(result.staging);
    if (result.error)
      firstError ??= new Error(
        ["report_output_encoding_unsupported", "report_storage_failed"].includes(
          result.error.message
        )
          ? result.error.message
          : "report_output_invalid"
      );
    repo.dataset(report.id, {
      kind,
      availability: result.columns.length
        ? result.rowCount === "0"
          ? "EMPTY"
          : "AVAILABLE"
        : "UNSUPPORTED",
      complete,
      rowCount: result.rowCount,
      reason: result.error?.message ?? null,
      columns: result.columns,
      sourceArtifactId: source.id,
      csvArtifactId: csv?.id
    });
  }
  report = repo.get(report.id)!;
  report.projectionRevision = revision;
  const required: Record<string, string[]> = {
    chain: ["Num Blocks"],
    index: ["Blocks", "Size", "Utilization"],
    table: ["Records", "Size", "Frag Factor", "Scatter Factor"],
    block: ["Num Blocks"],
    lob: ["LOBs", "Size"]
  };
  const unsupported = report.datasets.some(
    (d) =>
      ["AVAILABLE", "EMPTY"].includes(d.availability) &&
      required[d.kind].some((header) => !d.columns.some((c) => c.sourceHeader === header))
  );
  report.projectionState =
    firstError || !nativeComplete ? "PARTIAL" : unsupported ? "UNSUPPORTED" : "READY";
  const summary = buildSummary(repo, report, revision);
  repo.transaction(() => {
    repo.db
      .prepare("INSERT INTO report_summaries VALUES(?,?,?)")
      .run(report.id, revision, JSON.stringify(summary));
    repo.save(report);
  });
  const current = repo.get(report.id)!;
  storage.publish(
    report.id,
    "report.v1.json",
    JSON.stringify(current, null, 2),
    "MANIFEST",
    nativeComplete && !firstError
  );
  if (firstError && nativeComplete) throw firstError;
  return current;
}
