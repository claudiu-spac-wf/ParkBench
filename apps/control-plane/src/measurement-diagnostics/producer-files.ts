import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { validateMeasurementEvidence } from "../../../../packages/contracts/src/measurement-diagnostics";
import { validateDiagnosticMetadata } from "./metadata";
/** Refuse oversized/partial lines before allocating an unbounded line buffer. */
export async function* diagnosticLines(file: string, maxBytes = 4096): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const input of createReadStream(file, { highWaterMark: maxBytes })) {
    const chunk = input as Buffer;
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset),
        stop = end < 0 ? chunk.length : end;
      if (pending.length + stop - offset > maxBytes)
        throw new Error("measurement_producer_record_oversized");
      pending = Buffer.concat([pending, chunk.subarray(offset, stop)]);
      if (end < 0) break;
      yield pending.toString("utf8");
      pending = Buffer.alloc(0);
      offset = end + 1;
    }
  }
  if (pending.length) throw new Error("measurement_producer_partial_record");
}
const stages = new Set([
  "SCHEDULE",
  "INFRASTRUCTURE",
  "DISPATCH",
  "HTTP",
  "NATIVE_CAPTURE",
  "PARSE",
  "PHASE_FILTER",
  "BUFFER_APPEND",
  "EXPOSITION",
  "QUERY",
  "PROJECTION",
  "FINALIZATION",
  "DIAGNOSTIC_WRITE"
]);
const outcomes = new Set([
  "STARTED",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "SKIPPED",
  "REJECTED",
  "SHARED",
  "UNCONFIRMED"
]);
const terminalFields = new Set([
  "contractVersion",
  "component",
  "componentInstanceId",
  "reservationId",
  "sequenceStart",
  "sequenceEnd",
  "attemptedEvents",
  "acceptedEvents",
  "unconfirmedEvents",
  "lostSequenceRanges",
  "lostSequenceRangesIncomplete",
  "retainedEvents",
  "droppedEvents",
  "droppedMetadataRecords",
  "writeFailures",
  "summaryBytes",
  "traceBytes",
  "pendingBytes",
  "recordingState",
  "budgetAccountingState",
  "flushState"
]);
export async function inspectProducerFile(
  file: string,
  owner: { runId: string; attemptId: string; component: string; instanceId: string },
  kind: "summary" | "trace",
  maxBytes: number
) {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > maxBytes ||
    (await fs.realpath(file)) !== path.resolve(file)
  )
    throw new Error("measurement_producer_file_invalid");
  let terminal: any,
    records = 0;
  for await (const line of diagnosticLines(file)) {
    if (terminal) throw new Error("measurement_producer_after_terminal");
    const r = JSON.parse(line);
    records++;
    if (r.contractVersion === "measurement-producer-terminal.v1") {
      if (
        kind !== "summary" ||
        r.component !== owner.component ||
        r.componentInstanceId !== owner.instanceId ||
        Object.keys(r).some((k) => !terminalFields.has(k))
      )
        throw new Error("measurement_producer_terminal_invalid");
      for (const key of [
        "sequenceStart",
        "sequenceEnd",
        "attemptedEvents",
        "acceptedEvents",
        "unconfirmedEvents",
        "retainedEvents",
        "droppedEvents",
        "droppedMetadataRecords",
        "writeFailures",
        "summaryBytes",
        "traceBytes",
        "pendingBytes"
      ])
        if (!Number.isSafeInteger(r[key]) || r[key] < 0)
          throw new Error("measurement_producer_terminal_count");
      if (
        !/^[a-f0-9-]{36}$/.test(r.reservationId) ||
        !Array.isArray(r.lostSequenceRanges) ||
        r.lostSequenceRanges.length > 32 ||
        r.lostSequenceRanges.some(
          (pair: any) =>
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            pair.some((n: any) => !Number.isSafeInteger(n) || n < 0)
        ) ||
        typeof r.lostSequenceRangesIncomplete !== "boolean" ||
        !["SEALED", "TRUNCATED", "UNAVAILABLE"].includes(r.recordingState) ||
        !["CONFIRMED", "UNCONFIRMED"].includes(r.budgetAccountingState) ||
        !["COMPLETE", "FAILED", "PENDING"].includes(r.flushState) ||
        r.summaryBytes !== stat.size
      )
        throw new Error("measurement_producer_terminal_accounting");
      terminal = r;
      continue;
    }
    if (
      r.runId !== owner.runId ||
      r.diagnosticAttemptId !== owner.attemptId ||
      r.componentInstanceId !== owner.instanceId
    )
      throw new Error("measurement_producer_record_owner");
    if (r.contractVersion === "measurement-observation.v1") {
      validateMeasurementEvidence(r);
      if (r.component !== owner.component) throw new Error("measurement_producer_component");
    } else if (r.contractVersion === "measurement-evidence-record.v1") {
      if (
        owner.component !== "metadata" ||
        Object.keys(r).some(
          (k) =>
            ![
              "contractVersion",
              "eventId",
              "runId",
              "diagnosticAttemptId",
              "componentInstanceId",
              "sequence",
              "record"
            ].includes(k)
        )
      )
        throw new Error("measurement_producer_metadata_owner");
      validateDiagnosticMetadata(r.record);
    } else if (r.contractVersion === "measurement-stage-aggregate.v1") {
      if (
        Object.keys(r).some(
          (k) =>
            ![
              "contractVersion",
              "runId",
              "diagnosticAttemptId",
              "componentInstanceId",
              "stage",
              "outcome",
              "count",
              "durationMs"
            ].includes(k)
        ) ||
        !stages.has(r.stage) ||
        !outcomes.has(r.outcome) ||
        !Number.isSafeInteger(r.count) ||
        r.count < 0 ||
        !Number.isFinite(r.durationMs) ||
        r.durationMs < 0
      )
        throw new Error("measurement_producer_aggregate_invalid");
    } else throw new Error("measurement_producer_unknown_record");
  }
  return { terminal, bytes: stat.size, records };
}

/** Read-only validation for immutable diagnostic downloads, including symlink swaps. */
export async function diagnosticDownloadPath(
  rootPath: string,
  artifact: import("../../../../packages/contracts/src/artifacts").Artifact
): Promise<string | undefined> {
  const metadata = artifact.sourceMetadata;
  if (
    artifact.kind !== "diagnostics" ||
    !["measurement-diagnostics.v1", "measurement-diagnostics-retention.v1"].includes(
      String(metadata?.contractVersion)
    )
  )
    return;
  for (const part of [artifact.runId, String(metadata?.attemptId)])
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(part))
      throw new Error("measurement_download_owner");
  const root = await fs.realpath(rootPath),
    owned = path.join(root, artifact.runId, "measurement-diagnostics"),
    file = path.resolve(root, artifact.path);
  const role = String(metadata.role),
    base =
      role === "retention-event"
        ? path.join(owned, "retention")
        : path.join(owned, String(metadata.attemptId));
  if (
    path.isAbsolute(artifact.path) ||
    !file.startsWith(base + path.sep) ||
    (await fs.realpath(file)) !== file
  )
    throw new Error("measurement_download_path");
  const stat = await fs.lstat(file),
    limit =
      role === "trace" ? 128 * 1024 ** 2 : role === "producer-summary" ? 64 * 1024 ** 2 : 262144;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== artifact.sizeBytes ||
    stat.size > limit
  )
    throw new Error("measurement_download_size");
  return file;
}
