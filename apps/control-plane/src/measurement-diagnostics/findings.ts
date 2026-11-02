import { randomUUID } from "node:crypto";
import {
  canonicalDimensions,
  CoverageFinding,
  MeasurementExpectation
} from "../../../../packages/contracts/src/measurement-diagnostics";
import type { MeasurementDiagnosticsWriter } from "./writer";
import { diagnosticLines } from "./producer-files";
import { validateDiagnosticMetadata } from "./metadata";
interface Member {
  group: string;
  memberId: string;
}
const coverageFields = [
  "supportedSeconds",
  "estimatedSeconds",
  "missingSeconds",
  "availableBins",
  "omittedBins",
  "expectedAcquisitions",
  "observedAcquisitions"
] as const;
/** Index only problem metadata. Source values/series never enter the index. Every
 * retained key and the streaming buffer share the producer's pending allowance. */
export async function findingEvidence(
  file: string,
  writer: MeasurementDiagnosticsWriter,
  members: Member[],
  singlePath: boolean
) {
  const projectionReleases = new Map<string, () => void>(),
    projections = new Map<string, any>(),
    queries: any[] = [],
    selectors = new Map<string, any>(),
    releases = new Set<() => void>();
  let incomplete = false;
  const hold = (record: unknown, compactBytes?: number) => {
    const bytes = compactBytes ?? Buffer.byteLength(JSON.stringify(record)) * 2 + 128;
    const release = writer.reserveWorkingMemory(bytes);
    if (!release) {
      incomplete = true;
      return false;
    }
    let released = false;
    const free = () => {
      if (!released) {
        released = true;
        releases.delete(free);
        release();
      }
    };
    releases.add(free);
    return free;
  };
  const key = (
    definitionId: string,
    group: string,
    dimensions: Record<string, string>,
    statistic: string
  ) => {
    const identity = { ...dimensions };
    if (
      definitionId === "disk.space.bi_logical" ||
      (singlePath && ["disk.space.file_size", "disk.space.allocated"].includes(definitionId))
    )
      delete identity.file;
    return JSON.stringify([definitionId, group, canonicalDimensions(identity), statistic]);
  };
  const lineBuffer = writer.reserveWorkingMemory(8192);
  if (!lineBuffer) incomplete = true;
  else
    try {
      for await (const line of diagnosticLines(file)) {
        const envelope = JSON.parse(line);
        if (envelope.contractVersion !== "measurement-evidence-record.v1") continue;
        const record: any = validateDiagnosticMetadata(envelope.record);
        if (record.contractVersion === "measurement-projection.v1") {
          const identity = key(
            record.definitionId,
            record.group,
            record.dimensions,
            record.statistic
          );
          projectionReleases.get(identity)?.();
          projectionReleases.delete(identity);
          projections.delete(identity);
          if (!["available", "estimated"].includes(record.status)) {
            // Full projections remain in the immutable metadata spool. The lookup
            // needs only its reference, reason and seven coverage numbers.
            const problem = {
                reasonCode: record.reasonCodes[0] ?? "projection_unavailable",
                evidenceRef: envelope.eventId,
                coverage: new Float64Array(
                  coverageFields.map((field) => (record[field] === null ? NaN : record[field]))
                )
              },
              allocation = hold(
                problem,
                identity.length * 2 +
                  problem.reasonCode.length * 2 +
                  problem.evidenceRef.length * 2 +
                  problem.coverage.byteLength +
                  128
              );
            if (allocation) {
              projections.set(identity, problem);
              projectionReleases.set(identity, allocation);
            }
          }
        }
        if (
          record.contractVersion === "measurement-query-evidence.v1" &&
          (record.missingMemberIds.length ||
            record.sampleCount === 0 ||
            record.outcome !== "SUCCEEDED")
        ) {
          const problem = {
            definitionId: record.definitionId,
            dimensions: record.dimensions,
            expectedMemberIds: record.expectedMemberIds,
            missingMemberIds: record.missingMemberIds,
            memberCount: record.memberCount,
            sampleCount: record.sampleCount,
            outcome: record.outcome,
            selectorRef: record.selectorRef,
            queryId: record.queryId,
            startMs: record.effectiveStartMs,
            endMs: record.effectiveEndMs
          };
          if (hold(problem)) queries.push(problem);
        }
      }
      const needed = new Set(queries.map((query) => query.selectorRef));
      if (needed.size)
        for await (const line of diagnosticLines(file)) {
          const envelope = JSON.parse(line),
            record = envelope.record;
          if (
            envelope.contractVersion !== "measurement-evidence-record.v1" ||
            record?.contractVersion !== "measurement-query-selector.v1" ||
            !needed.has(record.selectorId)
          )
            continue;
          validateDiagnosticMetadata(record);
          const selector = { metricName: record.metricName, matchers: record.matchers };
          if (hold(selector)) selectors.set(record.selectorId, selector);
        }
    } catch {
      incomplete = true;
    } finally {
      lineBuffer();
    }
  const release = () => {
    for (const free of releases) free();
  };
  function finding(expectation: MeasurementExpectation): CoverageFinding | undefined {
    const base = {
      contractVersion: "measurement-finding.v1" as const,
      findingId: randomUUID(),
      runId: expectation.runId,
      expectationId: expectation.expectationId,
      symptom: "measurement_coverage",
      startMs: expectation.startMs,
      endMs: expectation.endMs,
      lastConfirmedStage: null,
      classification: "UNRESOLVED" as const,
      reasonCode: "coverage_evidence_incomplete",
      evidenceRefs: [] as string[],
      hypothesisIds: [],
      state: "OPEN" as const,
      coverage: {} as Record<string, number>,
      missingMemberIds: [] as string[],
      nativeAvailability: null
    };
    if (expectation.applicability !== "EXPECTED")
      return {
        ...base,
        symptom: "measurement_applicability",
        classification:
          ["INAPPLICABLE", "UNSUPPORTED"].includes(expectation.applicability) &&
          expectation.evidenceRefs.length
            ? "LEGITIMATE_LIMITATION"
            : "UNRESOLVED",
        reasonCode: expectation.applicabilityReason ?? "applicability_unresolved",
        evidenceRefs: expectation.evidenceRefs
      };
    const group = expectation.scope.split(":")[0],
      scopeMembers = members
        .filter((member) => member.group === group)
        .map((member) => member.memberId),
      dimensions = { ...expectation.dimensions };
    if (dimensions.scope === group) delete dimensions.scope;
    for (const query of queries) {
      if (
        query.definitionId !== expectation.definitionId ||
        query.endMs <= expectation.startMs ||
        query.startMs >= expectation.endMs
      )
        continue;
      const missing = query.missingMemberIds.filter((id: string) =>
        expectation.dimensions.member
          ? id === expectation.dimensions.member
          : scopeMembers.includes(id)
      );
      if (missing.length)
        return {
          ...base,
          reasonCode: "required_member_missing",
          evidenceRefs: [query.queryId],
          missingMemberIds: missing,
          coverage: {
            expectedMembers: query.expectedMemberIds.length,
            matchedMembers: query.memberCount
          }
        };
    }
    if (!expectation.dimensions.member) {
      const projection = projections.get(
        key(expectation.definitionId, group, dimensions, expectation.statistic)
      );
      if (projection)
        return {
          ...base,
          reasonCode: projection.reasonCode,
          evidenceRefs: [projection.evidenceRef],
          coverage: Object.fromEntries(
            coverageFields.flatMap((field, i) =>
              Number.isFinite(projection.coverage[i]) ? [[field, projection.coverage[i]]] : []
            )
          )
        };
    }
    for (const query of queries) {
      if (
        query.sampleCount !== 0 ||
        query.endMs <= expectation.startMs ||
        query.startMs >= expectation.endMs
      )
        continue;
      const selector = selectors.get(query.selectorRef);
      if (
        query.definitionId !== expectation.definitionId &&
        selector?.metricName !== expectation.definitionId
      )
        continue;
      if (
        query.expectedMemberIds.length &&
        !query.expectedMemberIds.some((id: string) => scopeMembers.includes(id))
      )
        continue;
      if (
        query.definitionId === expectation.definitionId &&
        canonicalDimensions(query.dimensions) !== canonicalDimensions(dimensions)
      )
        continue;
      if (
        selector?.matchers.some((matcher: any) => {
          const value = expectation.dimensions[matcher.name];
          if (value === undefined) return false;
          if (matcher.operator === "=") return value !== matcher.value;
          if (matcher.operator === "!=") return value === matcher.value;
          const matches = new RegExp(`^(?:${matcher.value})$`).test(value);
          return matcher.operator === "=~" ? !matches : matches;
        })
      )
        continue;
      return {
        ...base,
        reasonCode:
          query.outcome === "SUCCEEDED" ? "query_no_stored_samples" : "source_query_failed",
        evidenceRefs: [query.queryId],
        coverage: { returnedSamples: 0 }
      };
    }
  }
  return { incomplete, release, finding };
}
