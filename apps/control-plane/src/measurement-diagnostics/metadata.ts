import { validateMeasurementEvidence } from "../../../../packages/contracts/src/measurement-diagnostics";
const shapes: Record<string, string[]> = {
  "measurement-inventory-status.v1": [
    "contractVersion",
    "runId",
    "diagnosticAttemptId",
    "inventoryIncomplete",
    "page",
    "totalPages",
    "missingInventoryKinds"
  ],
  "measurement-query-chunk.v1": [
    "contractVersion",
    "runId",
    "diagnosticAttemptId",
    "definitionId",
    "dimensions",
    "source",
    "requestedStartMs",
    "requestedEndMs",
    "effectiveStartMs",
    "effectiveEndMs",
    "returnedSamples",
    "retainedSamples",
    "duplicateSeamSamples",
    "cadenceMs"
  ],
  "measurement-topology.v1": ["contractVersion", "runId", "capturedAtMs", "members"],
  "measurement-projection.v1": [
    "contractVersion",
    "projectionStage",
    "definitionId",
    "group",
    "dimensions",
    "statistic",
    "status",
    "reasonCodes",
    "supportedSeconds",
    "estimatedSeconds",
    "missingSeconds",
    "availableBins",
    "omittedBins",
    "expectedAcquisitions",
    "observedAcquisitions",
    "minimumPercentileBins",
    "sourceReferences"
  ],
  "measurement-statistics-decision.v1": [
    "contractVersion",
    "startMs",
    "endMs",
    "cadenceMs",
    "physicalId",
    "storedObservations",
    "reasonCodes",
    "counts",
    "scope"
  ],
  "measurement-chart-query.v1": [
    "contractVersion",
    "queryId",
    "runIds",
    "mode",
    "queryMode",
    "requestedStartMs",
    "requestedEndMs",
    "stepMs",
    "durationMs",
    "seriesCount",
    "evaluationPointCount",
    "decisions",
    "incomplete",
    "droppedDecisionKinds"
  ],
  "measurement-query-selector.v1": [
    "contractVersion",
    "selectorId",
    "metricName",
    "matchers",
    "runIds",
    "source"
  ],
  "measurement-native-inventory-header.v1": [
    "contractVersion",
    "runId",
    "evidenceId",
    "capturedAtMs",
    "availabilityCount"
  ],
  "measurement-native-dimension.v1": ["contractVersion", "evidenceId", "dimension", "identities"],
  "measurement-native-availability.v1": [
    "contractVersion",
    "evidenceId",
    "metricName",
    "dimensions",
    "availability",
    "reasonCode",
    "sourceRef"
  ],
  "measurement-path-inventory.v1": [
    "contractVersion",
    "runId",
    "observerId",
    "pathRef",
    "kind",
    "capturedAtMs"
  ],
  "measurement-publication.v1": [
    "contractVersion",
    "runId",
    "summaryAttemptId",
    "version",
    "cache",
    "publicationOutcome"
  ],
  "measurement-inventory-delta.v1": [
    "contractVersion",
    "deltaId",
    "runId",
    "recordedAtMs",
    "action",
    "member",
    "evidenceRef"
  ]
};
const nested = new Set([
  "metric",
  "contractVersion",
  "name",
  "operator",
  "value",
  "definitionIds",
  "group",
  "coverageScope",
  "dimensions",
  "stage",
  "outcome",
  "runId",
  "requestedStartMs",
  "requestedEndMs",
  "effectiveStartMs",
  "effectiveEndMs",
  "stepMs",
  "cadenceMs",
  "lookbackMs",
  "shiftMs",
  "sourceTimestampMinMs",
  "sourceTimestampMaxMs",
  "counts",
  "reasonCodes",
  "eventCount",
  "service",
  "memberId",
  "replica",
  "imageId"
]);
const statisticCounters = new Set([
  "resetIntervals",
  "epochTransitionIntervals",
  "duplicateTimestamps",
  "conflictingTimestamps",
  "gapIntervals"
]);
const chartCounters = new Set([
  "requestCount",
  "responseBytes",
  "queueWaitMs",
  "requestDurationMs",
  "bodyReadMs",
  "sourceSeries",
  "storedSourcePoints",
  "cacheHits",
  "cacheMisses",
  "returnedPoints",
  "retainedPoints",
  "rejectedPoints",
  "selectedPoints",
  "resetIntervals"
]);
/** Fixed metadata fields only; values are permitted solely as selector string identities. */
export function validateDiagnosticMetadata(input: unknown): unknown {
  let serializedBytes = 0;
  const size = (value: any, depth = 0) => {
    if (depth > 10 || serializedBytes > 3500)
      throw new Error("measurement_metadata_invalid:record_size");
    if (value === undefined) return;
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      serializedBytes += 24;
      return;
    }
    if (typeof value === "string") {
      if (value.length > 1024) throw new Error("measurement_metadata_invalid:string");
      serializedBytes += Buffer.byteLength(JSON.stringify(value));
      return;
    }
    if (typeof value !== "object") throw new Error("measurement_metadata_invalid:type");
    if (Array.isArray(value)) {
      if (value.length > 1024) throw new Error("measurement_metadata_invalid:array");
      for (const child of value) size(child, depth + 1);
      serializedBytes += value.length + 2;
    } else {
      const keys = Object.keys(value);
      if (keys.length > 128) throw new Error("measurement_metadata_invalid:object");
      for (const key of keys) {
        serializedBytes += key.length + 4;
        size(value[key], depth + 1);
      }
    }
    if (serializedBytes > 3500) throw new Error("measurement_metadata_invalid:record_size");
  };
  size(input);
  const record = input as any;
  if (
    record?.contractVersion === "measurement-query-evidence.v1" ||
    record?.contractVersion === "measurement-expectation.v1" ||
    record?.contractVersion === "measurement-finding.v1" ||
    record?.contractVersion === "measurement-diagnostics-retention.v1"
  )
    return validateMeasurementEvidence(record);
  const allowed =
    typeof record?.contractVersion === "string" && Object.hasOwn(shapes, record.contractVersion)
      ? shapes[record.contractVersion]
      : undefined;
  const optional =
    record?.contractVersion === "measurement-statistics-decision.v1" ? ["scope"] : [];
  if (allowed && allowed.some((key) => !optional.includes(key) && !Object.hasOwn(record, key)))
    throw new Error("measurement_metadata_invalid:required_fields");
  if (
    !allowed ||
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).some((key) => !allowed.includes(key))
  )
    throw new Error("measurement_metadata_invalid:fields");
  const visit = (value: any, parent: string, depth: number) => {
    if (depth > 7) throw new Error("measurement_metadata_invalid:depth");
    if (value === null || value === undefined || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (value.length > 1024) throw new Error("measurement_metadata_invalid:string");
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
        throw new Error("measurement_metadata_invalid:number");
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 128) throw new Error("measurement_metadata_invalid:array");
      for (const item of value) visit(item, parent, depth + 1);
      return;
    }
    if (typeof value !== "object" || Object.keys(value).length > 32)
      throw new Error("measurement_metadata_invalid:object");
    for (const [key, child] of Object.entries(value)) {
      if (parent === "dimensions") {
        if (typeof child !== "string" || key.length > 128)
          throw new Error("measurement_metadata_invalid:dimensions");
      } else if (parent === "counts") {
        if (
          typeof child !== "number" ||
          !Number.isFinite(child) ||
          child < 0 ||
          !(
            record.contractVersion === "measurement-statistics-decision.v1"
              ? statisticCounters
              : chartCounters
          ).has(key)
        )
          throw new Error("measurement_metadata_invalid:counts");
      } else if (
        !nested.has(key) ||
        (key === "value" && (parent !== "matchers" || typeof child !== "string"))
      )
        throw new Error("measurement_metadata_invalid:nested_field");
      visit(child, key, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(record)) visit(value, key, 0);
  if (Buffer.byteLength(JSON.stringify(record)) > 3500)
    throw new Error("measurement_metadata_invalid:record_size");
  return structuredClone(record);
}
