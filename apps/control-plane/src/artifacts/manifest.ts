import crypto from "node:crypto";
import { Artifact, ArtifactKind } from "../../../../packages/contracts/src/artifacts";
export function artifactRecord(
  runId: string,
  kind: ArtifactKind,
  file: { path: string; sizeBytes: number },
  format: string,
  sourceMetadata?: Record<string, unknown>
): Artifact {
  return {
    id: `artifact_${crypto.randomUUID()}`,
    runId,
    kind,
    path: file.path,
    sizeBytes: file.sizeBytes,
    format,
    sourceMetadata,
    createdAt: new Date().toISOString(),
    retained: true
  };
}

import fs from "node:fs";
import { RunSummaryHeader } from "../../../../packages/contracts/src/run-summary";
export interface SummaryArtifact extends Artifact {
  kind: "run_comparison_summary";
}
const receipts = new WeakMap<
  object,
  { absolutePath: string; size: number; ino: number; mtime: number; token: string; header: string }
>();
export function completedSummaryArtifact(
  header: RunSummaryHeader,
  token: string,
  file: { path: string; sizeBytes: number },
  absolutePath: string
): SummaryArtifact {
  const stat = fs.statSync(absolutePath);
  const id =
    "summary_" +
    Buffer.from(JSON.stringify([header.run.id, header.metricDefinitionsVersion])).toString(
      "base64url"
    );
  const record: SummaryArtifact = {
    ...artifactRecord(header.run.id, "run_comparison_summary", file, "json", {
      contractVersion: header.contractVersion,
      metricDefinitionsVersion: header.metricDefinitionsVersion,
      attemptToken: token,
      totalRowCount: header.totalRowCount
    }),
    id,
    kind: "run_comparison_summary"
  };
  receipts.set(record, {
    absolutePath,
    size: stat.size,
    ino: stat.ino,
    mtime: stat.mtimeMs,
    token,
    header: JSON.stringify(header)
  });
  return record;
}
export function verifySummaryArtifact(
  artifact: SummaryArtifact,
  header: RunSummaryHeader,
  token: string
): void {
  const receipt = receipts.get(artifact);
  if (
    !receipt ||
    receipt.token !== token ||
    receipt.header !== JSON.stringify(header) ||
    artifact.runId !== header.run.id ||
    artifact.kind !== "run_comparison_summary"
  )
    throw new Error("summary_artifact_invalid");
  const stat = fs.statSync(receipt.absolutePath);
  if (
    !stat.isFile() ||
    stat.size !== receipt.size ||
    stat.ino !== receipt.ino ||
    stat.mtimeMs !== receipt.mtime
  )
    throw new Error("summary_artifact_invalid");
}
