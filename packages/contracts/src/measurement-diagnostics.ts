import Ajv2020 from "ajv/dist/2020";

export interface MeasurementDiagnosticsConfig {
  contractVersion: "measurement-diagnostics-config.v1";
  mode: "summary" | "trace";
}
export const DIAGNOSTIC_DEFAULTS = Object.freeze({
  summaryLimitBytes: 8 * 1024 ** 2,
  traceLimitBytes: 32 * 1024 ** 2,
  pendingLimitBytes: 1024 ** 2,
  eventLimitBytes: 4096,
  flushIntervalMs: 1000,
  traceTtlMs: 7 * 86400000,
  retainedTraceLimitBytes: 1024 ** 3
});
export interface DiagnosticsOperatorSettings {
  summaryLimitBytes: number;
  traceLimitBytes: number;
  pendingLimitBytes: number;
  eventLimitBytes: number;
  flushIntervalMs: number;
  traceTtlMs: number;
  retainedTraceLimitBytes: number;
}
export interface FrozenDiagnosticsConfig
  extends MeasurementDiagnosticsConfig, DiagnosticsOperatorSettings {
  frozenAtMs: number;
  retentionControlBytes: number;
}
export function loadDiagnosticsSettings(env: NodeJS.ProcessEnv): DiagnosticsOperatorSettings {
  const keys = {
    PARKBENCH_DIAGNOSTICS_SUMMARY_BYTES: ["summaryLimitBytes", 262144, 64 * 1024 ** 2],
    PARKBENCH_DIAGNOSTICS_TRACE_BYTES: ["traceLimitBytes", 4096, 128 * 1024 ** 2],
    PARKBENCH_DIAGNOSTICS_PENDING_BYTES: ["pendingLimitBytes", 1024, 1024 ** 2],
    PARKBENCH_DIAGNOSTICS_EVENT_BYTES: ["eventLimitBytes", 512, 4096],
    PARKBENCH_DIAGNOSTICS_FLUSH_MS: ["flushIntervalMs", 1, 1000],
    PARKBENCH_DIAGNOSTICS_TRACE_TTL_MS: ["traceTtlMs", 1, 365 * 86400000],
    PARKBENCH_DIAGNOSTICS_RETAINED_TRACE_BYTES: [
      "retainedTraceLimitBytes",
      4096,
      Number.MAX_SAFE_INTEGER
    ]
  } as const;
  const result: DiagnosticsOperatorSettings = { ...DIAGNOSTIC_DEFAULTS };
  for (const key of Object.keys(env))
    if (key.startsWith("PARKBENCH_DIAGNOSTICS_") && !Object.hasOwn(keys, key))
      throw new Error(`platform_setting_invalid:${key}`);
  for (const [key, [field, min, max]] of Object.entries(keys)) {
    if (env[key] === undefined) continue;
    const value = Number(env[key]);
    if (!/^[0-9]+$/.test(env[key]!) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`platform_setting_invalid:${key}`);
    result[field] = value;
  }
  if (result.eventLimitBytes > result.pendingLimitBytes)
    throw new Error("platform_setting_invalid:PARKBENCH_DIAGNOSTICS_PENDING_BYTES");
  return result;
}
export function freezeDiagnosticsConfig(
  input: unknown,
  settings: DiagnosticsOperatorSettings,
  frozenAtMs: number
): FrozenDiagnosticsConfig {
  if (!Number.isSafeInteger(frozenAtMs) || frozenAtMs < 0)
    throw new Error("measurement_diagnostics_invalid:freeze_time");
  const env = {
    PARKBENCH_DIAGNOSTICS_SUMMARY_BYTES: String(settings.summaryLimitBytes),
    PARKBENCH_DIAGNOSTICS_TRACE_BYTES: String(settings.traceLimitBytes),
    PARKBENCH_DIAGNOSTICS_PENDING_BYTES: String(settings.pendingLimitBytes),
    PARKBENCH_DIAGNOSTICS_EVENT_BYTES: String(settings.eventLimitBytes),
    PARKBENCH_DIAGNOSTICS_FLUSH_MS: String(settings.flushIntervalMs),
    PARKBENCH_DIAGNOSTICS_TRACE_TTL_MS: String(settings.traceTtlMs),
    PARKBENCH_DIAGNOSTICS_RETAINED_TRACE_BYTES: String(settings.retainedTraceLimitBytes)
  };
  return Object.freeze({
    ...normalizeMeasurementDiagnostics(input),
    ...loadDiagnosticsSettings(env),
    frozenAtMs,
    retentionControlBytes: 65536
  });
}
export interface DiagnosticSlot {
  runId: string;
  diagnosticAttemptId: string;
  phase: string;
  observerId: string;
  slotRuleVersion: string;
  cadenceMs: number;
  ordinal: number;
}
export const DIAGNOSTIC_STAGES = [
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
] as const;
export const DIAGNOSTIC_OUTCOMES = [
  "STARTED",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "SKIPPED",
  "REJECTED",
  "SHARED",
  "UNCONFIRMED"
] as const;
export interface ObservationEvidence {
  contractVersion: "measurement-observation.v1";
  eventId: string;
  runId: string;
  experimentId: string;
  diagnosticAttemptId: string;
  component: string;
  componentInstanceId: string;
  sequence: number;
  stage: (typeof DIAGNOSTIC_STAGES)[number];
  outcome: (typeof DIAGNOSTIC_OUTCOMES)[number];
  phase?: string;
  observerId?: string;
  expectationId?: string;
  sourceKey?: string;
  slotId?: string;
  parentEventId?: string;
  controllerAttempt?: number;
  httpAttempt?: number;
  queryId?: string;
  summaryAttemptId?: string;
  scheduledAtMs: number | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  sourceCapturedAtMs: number | null;
  availableAtMs: number | null;
  timestampOrigin: "SOURCE" | "SCRAPE_ASSIGNED" | "PARSER_ASSIGNED" | "UNKNOWN";
  durationMs: number;
  queueWaitMs: number;
  bodyReadMs: number;
  collectionGeneration?: number;
  sharedWithCollectionId?: string;
  callerRole: "CONTROLLER" | "SCRAPER" | "UNKNOWN";
  counts?: Record<string, number>;
  reasonCodes?: string[];
  evidenceRefs?: string[];
  sourceTimestampMinMs?: number | null;
  sourceTimestampMaxMs?: number | null;
  skippedOrdinalStart?: number;
  skippedOrdinalEnd?: number;
  clockUncertaintyMs?: number | null;
}
export type MeasurementConsumingView =
  | { consumer: "SUMMARY" | "COMPARISON"; definitionRef: string }
  | { consumer?: "GRAFANA"; dashboardUid: string; panelId: string };
export interface MeasurementExpectation {
  contractVersion: "measurement-expectation.v1";
  expectationId: string;
  runId: string;
  definitionId: string;
  semanticVersion: string;
  statistic: string;
  scope: string;
  dimensions: Record<string, string>;
  sourceKind: string;
  publisher: string;
  phase: string;
  startMs: number;
  endMs: number;
  sourceCadenceMs: number | null;
  controllerCadenceMs: number | null;
  scrapeCadenceMs: number | null;
  qualityRequirement: "required" | "optional";
  applicability: "EXPECTED" | "INAPPLICABLE" | "UNSUPPORTED" | "UNRESOLVED";
  applicabilityReason: string | null;
  evidenceRefs: string[];
  slotRuleVersion: string;
  expectedSlots: number;
  consumingViews: MeasurementConsumingView[];
}
export type FindingState =
  "OPEN" | "REPRODUCED" | "CAUSE_DEMONSTRATED" | "CORRECTED" | "REGRESSION_PASSED" | "CONFIRMED";
export interface CoverageFinding {
  contractVersion: "measurement-finding.v1";
  findingId: string;
  runId: string;
  expectationId: string;
  symptom: string;
  startMs: number;
  endMs: number;
  lastConfirmedStage: (typeof DIAGNOSTIC_STAGES)[number] | null;
  classification: "DEFECT" | "LEGITIMATE_LIMITATION" | "EXPIRED" | "UNRESOLVED";
  reasonCode: string;
  evidenceRefs: string[];
  hypothesisIds: string[];
  state: FindingState;
  coverage: Record<string, number>;
  missingMemberIds: string[];
  nativeAvailability: string | null;
  causeRef?: string;
  correctionRef?: string;
  regressionRefs?: string[];
}
export interface DiagnosticReservation {
  reservationId: string;
  attemptId: string;
  producerId: string;
  summaryBytes: number;
  traceBytes: number;
}
export interface RunBudgetLedger {
  contractVersion: "measurement-diagnostics-budget.v1";
  runId: string;
  runBudgetId: string;
  summaryLimitBytes: number;
  traceLimitBytes: number;
  committedSummaryBytes: number;
  committedTraceBytes: number;
  reservations: DiagnosticReservation[];
  accountingState: "CONFIRMED" | "UNCONFIRMED";
  revision: number;
}
export interface RetentionEvent {
  contractVersion: "measurement-diagnostics-retention.v1";
  eventId: string;
  runId: string;
  sequence: number;
  recordedAtMs: number;
  action: "PIN" | "UNPIN" | "EXPIRE_REQUESTED" | "EXPIRED" | "EXPIRE_FAILED";
  targetAttemptId: string;
  targetArtifactId: string;
  reasonCode: string;
  findingRef?: string;
  removedAtMs: number | null;
  errorCode?: string;
}
export interface QueryEvidence {
  contractVersion: "measurement-query-evidence.v1";
  runId: string;
  diagnosticAttemptId: string;
  queryId: string;
  parentQueryId?: string;
  summaryAttemptId?: string;
  consumer: "FINALIZATION" | "SUMMARY" | "COMPARISON" | "GRAFANA" | "AUDIT";
  mode: "RAW_STORED_SAMPLES" | "EVALUATION_GRID" | "NATIVE_COUNTER_WINDOW" | "SAVED_SUMMARY";
  runIds: string[];
  source: string;
  definitionId: string;
  semanticVersion: string;
  dimensions: Record<string, string>;
  expectedMemberIds: string[];
  selectorRef: string;
  expectationRefs: string[];
  requestedStartMs: number;
  requestedEndMs: number;
  effectiveStartMs: number;
  effectiveEndMs: number;
  stepMs: number | null;
  nativeCadenceMs: number | null;
  scrapeCadenceMs: number | null;
  lookbackMs: number | null;
  transforms: string[];
  counterEdgePolicy: string | null;
  queueWaitMs: number;
  durationMs: number;
  bodyReadMs: number;
  requestCount: number;
  pageCount: number;
  responseBytes: number;
  outcome: string;
  retryLevel: number;
  seriesCount: number;
  memberCount: number;
  sampleCount: number;
  sourceTimestampMinMs: number | null;
  sourceTimestampMaxMs: number | null;
  duplicateCount: number;
  conflictCount: number;
  resetCount: number;
  epochCount: number;
  reasonCodes: string[];
  missingMemberIds: string[];
  projections: Array<{
    expectationId: string;
    statistic: string;
    status: string;
    reasonCode: string | null;
    availableBins: number;
    supportedSeconds: number;
    estimatedSeconds: number;
    missingSeconds: number;
  }>;
  cache: "HIT" | "MISS" | "INVALIDATED" | "NONE";
  publicationOutcome: string | null;
  inventoryIncomplete: boolean;
}
export type RecordingState =
  "RECORDING" | "SEALED" | "TRUNCATED" | "UNAVAILABLE" | "INTERRUPTED" | "NOT_RECORDED";
export interface DiagnosticProducer {
  component: string;
  componentInstanceId: string;
  reservationId: string;
  summaryBytes: number;
  traceBytes: number;
  sequenceStart: number;
  sequenceEnd: number;
  attemptedEvents: number;
  retainedEvents: number;
  droppedEvents: number;
  writeFailures: number;
  flushState: "PENDING" | "COMPLETE" | "FAILED" | "UNCONFIRMED";
  budgetAccountingState: "CONFIRMED" | "UNCONFIRMED";
  acceptedEvents?: number;
  unconfirmedEvents?: number;
  lostSequenceRanges?: Array<[number, number]>;
  lostSequenceRangesIncomplete?: boolean;
  droppedMetadataRecords?: number;
  collectionStatus: "COMPLETE" | "MISSING" | "PARTIAL";
}
export interface RunDiagnosticsManifest {
  contractVersion: "measurement-diagnostics.v1";
  runId: string;
  experimentId: string;
  diagnosticAttemptId: string;
  parentDiagnosticAttemptId?: string;
  config: FrozenDiagnosticsConfig;
  createdAtMs: number;
  finalizedAtMs: number | null;
  recordingState: RecordingState;
  deployedRefs: Record<string, string>;
  phaseRefs: string[];
  cadenceRefs: string[];
  producers: DiagnosticProducer[];
  inventoryPages: string[];
  findingPages: string[];
  queryRefs: string[];
  artifactIndex: Array<{ artifactId: string; role: string; path: string; sizeBytes: number }>;
  stageAggregates: Array<{ stage: string; outcome: string; count: number; durationMs: number }>;
  summaryBytes: number;
  traceBytes: number;
  droppedEvents: number;
  writeFailures: number;
  inventoryIncomplete: boolean;
  findingsIncomplete: boolean;
  runBudgetId: string;
  budgetSnapshot: RunBudgetLedger;
}
export interface CampaignConfiguration {
  configurationId: string;
  workloadClass: "READ_ONLY" | "MIXED";
  setup: "NONE" | "ORDERED";
  scenarioSourceId: string;
  seedRef: string;
  archiveRef: string;
  setupRef: string | null;
  startupParameters: Record<string, string | number | boolean>;
  phases: { warmupSeconds: number; measurementSeconds: number; cooldownSeconds: number };
  concurrency: number;
  cadencesMs: Record<string, number>;
  deployedRefs: Record<string, string>;
  triggerConditions: string[];
  expectationRefs: string[];
  diagnostics: FrozenDiagnosticsConfig;
}
export interface CampaignAttempt {
  attemptId: string;
  configurationId: string;
  runId: string;
  revision: string;
  recordedAtMs: number;
  origin: "LIVE" | "HISTORICAL" | "FIXTURE" | "CONTROL" | "FAULT";
  sequenceOrdinal: number;
  assessment: "ACCEPTED" | "REJECTED" | "INCONCLUSIVE";
  runState: string;
  measurementValidity: string;
  cleanupState: string;
  diagnosticCompleteness: "COMPLETE" | "INCOMPLETE" | "UNAVAILABLE";
  sourceAuditRefs: string[];
  summaryAuditRefs: string[];
  chartRefs: string[];
  findingRefs: string[];
  reasonCodes: string[];
  previewRef: string;
  submitKey: string;
  startKey: string;
  hypothesisRef: string | null;
  intendedChangeRef: string | null;
  observedConditionRefs: string[];
  nextAction: string;
}
export interface MeasurementCampaign {
  contractVersion: "measurement-campaign.v1";
  campaignId: string;
  mode: "INVESTIGATE" | "CONFIRM";
  state:
    "DRAFT" | "DECLARED" | "RUNNING" | "ASSESSING" | "PASSED" | "NEEDS_INVESTIGATION" | "BLOCKED";
  specRef: string;
  revision: string;
  configurations: CampaignConfiguration[];
  attempts: CampaignAttempt[];
  expectationRefs: string[];
  findingRefs: string[];
  evidenceRefs: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

// Fixed allowlists intentionally exclude metric values, response arrays and arbitrary errors.
const text = { type: "string", minLength: 1, maxLength: 256 };
const id = { type: "string", minLength: 1, maxLength: 256, pattern: "^[a-zA-Z0-9_.:/@+ -]+$" };
const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const duration = { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableTime = { anyOf: [duration, { type: "null" }] };
const cadence = {
  anyOf: [
    { type: "number", exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    { type: "null" }
  ]
};
const nullableText = { anyOf: [text, { type: "null" }] };
const bool = { type: "boolean" };
const choice = (...values: readonly string[]) => ({ enum: values });
const list = (items: object, maxItems = 1024) => ({ type: "array", items, maxItems });
const refs = list(id);
const dictionary = (value: object, maxProperties = 256) => ({
  type: "object",
  propertyNames: id,
  additionalProperties: value,
  maxProperties
});
const object = (properties: Record<string, object>, optional: string[] = []) => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  additionalProperties: false
});
const versioned = (version: string, properties: Record<string, object>, optional: string[] = []) =>
  object({ contractVersion: { const: version }, ...properties }, optional);
const observationCountKeys = [
  "returnedSeries",
  "returnedSamples",
  "validSeries",
  "validSamples",
  "rejectedSeries",
  "rejectedSamples",
  "overwrittenEntries",
  "responseBytes",
  "attempts",
  "expectedSlots",
  "skippedSlots",
  "explicitTimestampSamples",
  "parserTimestampSamples",
  "httpStatus",
  "observedBatches",
  "availableMeasurements",
  "droppedDiagnosticKeys",
  "appendedSamples",
  "renderedSamples",
  "sampleLineBytes",
  "omittedGroups",
  "plannedPhaseDurationMs"
];
const observationCounts = object(
  Object.fromEntries(
    observationCountKeys.map((key) => [key, key === "plannedPhaseDurationMs" ? duration : count])
  ),
  observationCountKeys
);
const configSchema = versioned("measurement-diagnostics-config.v1", {
  mode: choice("summary", "trace")
});
const reservationSchema = object({
  reservationId: id,
  attemptId: id,
  producerId: id,
  summaryBytes: count,
  traceBytes: count
});
const budgetSchema = versioned("measurement-diagnostics-budget.v1", {
  runId: id,
  runBudgetId: id,
  summaryLimitBytes: { type: "integer", minimum: 4096, maximum: 64 * 1024 ** 2 },
  traceLimitBytes: { type: "integer", minimum: 0, maximum: 128 * 1024 ** 2 },
  committedSummaryBytes: count,
  committedTraceBytes: count,
  reservations: list(reservationSchema, 128),
  accountingState: choice("CONFIRMED", "UNCONFIRMED"),
  revision: count
});
const frozenSchema = object({
  contractVersion: { const: "measurement-diagnostics-config.v1" },
  mode: choice("summary", "trace"),
  summaryLimitBytes: count,
  traceLimitBytes: count,
  pendingLimitBytes: count,
  eventLimitBytes: count,
  flushIntervalMs: count,
  traceTtlMs: count,
  retainedTraceLimitBytes: count,
  frozenAtMs: duration,
  retentionControlBytes: { const: 65536 }
});
const campaignConfigurationSchema = object({
  configurationId: id,
  workloadClass: choice("READ_ONLY", "MIXED"),
  setup: choice("NONE", "ORDERED"),
  scenarioSourceId: id,
  seedRef: text,
  archiveRef: text,
  setupRef: nullableText,
  startupParameters: dictionary({ anyOf: [text, { type: "number" }, bool] }, 64),
  phases: object({
    warmupSeconds: duration,
    measurementSeconds: { type: "number", exclusiveMinimum: 0 },
    cooldownSeconds: duration
  }),
  concurrency: { type: "integer", minimum: 1 },
  cadencesMs: dictionary({ type: "number", exclusiveMinimum: 0 }),
  deployedRefs: dictionary(text),
  triggerConditions: refs,
  expectationRefs: refs,
  diagnostics: frozenSchema
});
const campaignAttemptSchema = object({
  attemptId: id,
  configurationId: id,
  runId: id,
  revision: text,
  recordedAtMs: duration,
  origin: choice("LIVE", "HISTORICAL", "FIXTURE", "CONTROL", "FAULT"),
  sequenceOrdinal: count,
  assessment: choice("ACCEPTED", "REJECTED", "INCONCLUSIVE"),
  runState: id,
  measurementValidity: id,
  cleanupState: id,
  diagnosticCompleteness: choice("COMPLETE", "INCOMPLETE", "UNAVAILABLE"),
  sourceAuditRefs: refs,
  summaryAuditRefs: refs,
  chartRefs: refs,
  findingRefs: refs,
  reasonCodes: refs,
  previewRef: id,
  submitKey: id,
  startKey: id,
  hypothesisRef: nullableText,
  intendedChangeRef: nullableText,
  observedConditionRefs: refs,
  nextAction: text
});
const schemas = {
  "measurement-diagnostics-config.v1": configSchema,
  "measurement-diagnostics-budget.v1": budgetSchema,
  "measurement-observation.v1": versioned(
    "measurement-observation.v1",
    {
      eventId: id,
      runId: id,
      experimentId: id,
      diagnosticAttemptId: id,
      component: id,
      componentInstanceId: id,
      sequence: count,
      stage: choice(...DIAGNOSTIC_STAGES),
      outcome: choice(...DIAGNOSTIC_OUTCOMES),
      phase: id,
      observerId: id,
      expectationId: id,
      sourceKey: id,
      slotId: { type: "string", minLength: 1, maxLength: 2048 },
      parentEventId: id,
      controllerAttempt: { type: "integer", minimum: 1 },
      httpAttempt: { type: "integer", minimum: 1 },
      queryId: id,
      summaryAttemptId: id,
      scheduledAtMs: nullableTime,
      startedAtMs: nullableTime,
      finishedAtMs: nullableTime,
      sourceCapturedAtMs: nullableTime,
      availableAtMs: nullableTime,
      timestampOrigin: choice("SOURCE", "SCRAPE_ASSIGNED", "PARSER_ASSIGNED", "UNKNOWN"),
      durationMs: duration,
      queueWaitMs: duration,
      bodyReadMs: duration,
      collectionGeneration: count,
      sharedWithCollectionId: id,
      callerRole: choice("CONTROLLER", "SCRAPER", "UNKNOWN"),
      counts: observationCounts,
      reasonCodes: list(id, 16),
      evidenceRefs: list(id, 16),
      sourceTimestampMinMs: nullableTime,
      sourceTimestampMaxMs: nullableTime,
      skippedOrdinalStart: count,
      skippedOrdinalEnd: count,
      clockUncertaintyMs: nullableTime
    },
    [
      "phase",
      "observerId",
      "expectationId",
      "sourceKey",
      "slotId",
      "parentEventId",
      "controllerAttempt",
      "httpAttempt",
      "queryId",
      "summaryAttemptId",
      "collectionGeneration",
      "sharedWithCollectionId",
      "counts",
      "reasonCodes",
      "evidenceRefs",
      "sourceTimestampMinMs",
      "sourceTimestampMaxMs",
      "skippedOrdinalStart",
      "skippedOrdinalEnd",
      "clockUncertaintyMs"
    ]
  ),
  "measurement-expectation.v1": versioned("measurement-expectation.v1", {
    expectationId: id,
    runId: id,
    definitionId: id,
    semanticVersion: id,
    statistic: id,
    scope: id,
    dimensions: dictionary(text, 32),
    sourceKind: id,
    publisher: id,
    phase: id,
    startMs: duration,
    endMs: duration,
    sourceCadenceMs: cadence,
    controllerCadenceMs: cadence,
    scrapeCadenceMs: cadence,
    qualityRequirement: choice("required", "optional"),
    applicability: choice("EXPECTED", "INAPPLICABLE", "UNSUPPORTED", "UNRESOLVED"),
    applicabilityReason: nullableText,
    evidenceRefs: refs,
    slotRuleVersion: choice("phase-start.v1"),
    expectedSlots: count,
    consumingViews: list(
      object(
        {
          consumer: choice("SUMMARY", "COMPARISON", "GRAFANA"),
          definitionRef: id,
          dashboardUid: id,
          panelId: id
        },
        ["consumer", "definitionRef", "dashboardUid", "panelId"]
      )
    )
  }),
  "measurement-finding.v1": versioned(
    "measurement-finding.v1",
    {
      findingId: id,
      runId: id,
      expectationId: id,
      symptom: text,
      startMs: duration,
      endMs: duration,
      lastConfirmedStage: { anyOf: [choice(...DIAGNOSTIC_STAGES), { type: "null" }] },
      classification: choice("DEFECT", "LEGITIMATE_LIMITATION", "EXPIRED", "UNRESOLVED"),
      reasonCode: id,
      evidenceRefs: refs,
      hypothesisIds: refs,
      state: choice(
        "OPEN",
        "REPRODUCED",
        "CAUSE_DEMONSTRATED",
        "CORRECTED",
        "REGRESSION_PASSED",
        "CONFIRMED"
      ),
      coverage: dictionary(duration, 32),
      missingMemberIds: refs,
      nativeAvailability: nullableText,
      causeRef: id,
      correctionRef: id,
      regressionRefs: refs
    },
    ["causeRef", "correctionRef", "regressionRefs"]
  ),
  "measurement-diagnostics-retention.v1": versioned(
    "measurement-diagnostics-retention.v1",
    {
      eventId: id,
      runId: id,
      sequence: count,
      recordedAtMs: duration,
      action: choice("PIN", "UNPIN", "EXPIRE_REQUESTED", "EXPIRED", "EXPIRE_FAILED"),
      targetAttemptId: id,
      targetArtifactId: id,
      reasonCode: id,
      findingRef: id,
      removedAtMs: nullableTime,
      errorCode: id
    },
    ["findingRef", "errorCode"]
  ),
  "measurement-query-evidence.v1": versioned(
    "measurement-query-evidence.v1",
    {
      runId: id,
      diagnosticAttemptId: id,
      queryId: id,
      parentQueryId: id,
      summaryAttemptId: id,
      consumer: choice("FINALIZATION", "SUMMARY", "COMPARISON", "GRAFANA", "AUDIT"),
      mode: choice(
        "RAW_STORED_SAMPLES",
        "EVALUATION_GRID",
        "NATIVE_COUNTER_WINDOW",
        "SAVED_SUMMARY"
      ),
      runIds: refs,
      source: id,
      definitionId: id,
      semanticVersion: id,
      dimensions: dictionary(text, 32),
      expectedMemberIds: refs,
      selectorRef: id,
      expectationRefs: refs,
      requestedStartMs: duration,
      requestedEndMs: duration,
      effectiveStartMs: duration,
      effectiveEndMs: duration,
      stepMs: cadence,
      nativeCadenceMs: cadence,
      scrapeCadenceMs: cadence,
      lookbackMs: nullableTime,
      transforms: refs,
      counterEdgePolicy: nullableText,
      queueWaitMs: duration,
      durationMs: duration,
      bodyReadMs: duration,
      requestCount: count,
      pageCount: count,
      responseBytes: count,
      outcome: choice(...DIAGNOSTIC_OUTCOMES),
      retryLevel: count,
      seriesCount: count,
      memberCount: count,
      sampleCount: count,
      sourceTimestampMinMs: nullableTime,
      sourceTimestampMaxMs: nullableTime,
      duplicateCount: count,
      conflictCount: count,
      resetCount: count,
      epochCount: count,
      reasonCodes: refs,
      missingMemberIds: refs,
      projections: list(
        object({
          expectationId: id,
          statistic: id,
          status: id,
          reasonCode: nullableText,
          availableBins: count,
          supportedSeconds: duration,
          estimatedSeconds: duration,
          missingSeconds: duration
        })
      ),
      cache: choice("HIT", "MISS", "INVALIDATED", "NONE"),
      publicationOutcome: nullableText,
      inventoryIncomplete: bool
    },
    ["parentQueryId", "summaryAttemptId"]
  ),
  "measurement-diagnostics.v1": versioned(
    "measurement-diagnostics.v1",
    {
      runId: id,
      experimentId: id,
      diagnosticAttemptId: id,
      parentDiagnosticAttemptId: id,
      config: frozenSchema,
      createdAtMs: duration,
      finalizedAtMs: nullableTime,
      recordingState: choice("RECORDING", "SEALED", "TRUNCATED", "UNAVAILABLE", "INTERRUPTED"),
      deployedRefs: dictionary(text),
      phaseRefs: refs,
      cadenceRefs: refs,
      producers: list(
        object(
          {
            component: id,
            componentInstanceId: id,
            reservationId: id,
            summaryBytes: count,
            traceBytes: count,
            sequenceStart: count,
            sequenceEnd: count,
            attemptedEvents: count,
            retainedEvents: count,
            droppedEvents: count,
            writeFailures: count,
            flushState: choice("PENDING", "COMPLETE", "FAILED", "UNCONFIRMED"),
            budgetAccountingState: choice("CONFIRMED", "UNCONFIRMED"),
            acceptedEvents: count,
            unconfirmedEvents: count,
            lostSequenceRanges: list(list(count, 2), 32),
            lostSequenceRangesIncomplete: { type: "boolean" },
            droppedMetadataRecords: count,
            collectionStatus: choice("COMPLETE", "MISSING", "PARTIAL")
          },
          [
            "acceptedEvents",
            "unconfirmedEvents",
            "lostSequenceRanges",
            "lostSequenceRangesIncomplete",
            "droppedMetadataRecords"
          ]
        ),
        128
      ),
      inventoryPages: refs,
      findingPages: refs,
      queryRefs: refs,
      artifactIndex: list(object({ artifactId: id, role: id, path: text, sizeBytes: count })),
      stageAggregates: list(
        object({
          stage: choice(...DIAGNOSTIC_STAGES),
          outcome: choice(...DIAGNOSTIC_OUTCOMES),
          count,
          durationMs: duration
        })
      ),
      summaryBytes: count,
      traceBytes: count,
      droppedEvents: count,
      writeFailures: count,
      inventoryIncomplete: bool,
      findingsIncomplete: bool,
      runBudgetId: id,
      budgetSnapshot: budgetSchema
    },
    ["parentDiagnosticAttemptId"]
  ),
  "measurement-campaign.v1": versioned("measurement-campaign.v1", {
    campaignId: id,
    mode: choice("INVESTIGATE", "CONFIRM"),
    state: choice(
      "DRAFT",
      "DECLARED",
      "RUNNING",
      "ASSESSING",
      "PASSED",
      "NEEDS_INVESTIGATION",
      "BLOCKED"
    ),
    specRef: text,
    revision: text,
    configurations: list(campaignConfigurationSchema, 128),
    attempts: list(campaignAttemptSchema, 4096),
    expectationRefs: refs,
    findingRefs: refs,
    evidenceRefs: refs,
    createdAtMs: duration,
    updatedAtMs: duration
  })
};
const ajv = new Ajv2020({ allErrors: false, strict: true });
const validators = Object.fromEntries(
  Object.entries(schemas).map(([version, schema]) => [version, ajv.compile(schema)])
);
function requireEvidence(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`measurement_diagnostics_invalid:${reason}`);
}
export function normalizeMeasurementDiagnostics(input: unknown): MeasurementDiagnosticsConfig {
  return input === undefined
    ? { contractVersion: "measurement-diagnostics-config.v1", mode: "summary" }
    : validateMeasurementEvidence(input);
}
export function validateMeasurementEvidence<T = any>(input: unknown): T {
  if (input === undefined) return { recordingState: "NOT_RECORDED" } as T;
  const version = (input as any)?.contractVersion;
  const validate =
    typeof version === "string" && Object.hasOwn(validators, version)
      ? validators[version]
      : undefined;
  requireEvidence(validate && validate(input), "schema");
  const v = input as any;
  if (v.startMs !== undefined) requireEvidence(v.endMs >= v.startMs, "window");
  if (v.contractVersion === "measurement-observation.v1") {
    if (v.slotId !== undefined) {
      let tuple: any;
      try {
        tuple = JSON.parse(v.slotId);
      } catch {
        throw new Error("measurement_diagnostics_invalid:slot_tuple");
      }
      requireEvidence(Array.isArray(tuple) && tuple.length === 7, "slot_tuple");
      requireEvidence(
        v.slotId ===
          measurementSlotId({
            runId: tuple[0],
            diagnosticAttemptId: tuple[1],
            phase: tuple[2],
            observerId: tuple[3],
            slotRuleVersion: tuple[4],
            cadenceMs: tuple[5],
            ordinal: tuple[6]
          }) &&
          tuple[0] === v.runId &&
          tuple[1] === v.diagnosticAttemptId &&
          (v.observerId === undefined || tuple[3] === v.observerId) &&
          (v.phase === undefined || tuple[2] === v.phase),
        "slot_tuple_owner"
      );
    }

    requireEvidence(
      !(v.timestampOrigin === "UNKNOWN" && v.sourceCapturedAtMs !== null),
      "unknown_source_time"
    );
    requireEvidence(
      v.sourceCapturedAtMs === null || v.timestampOrigin === "SOURCE",
      "source_time_provenance"
    );
    requireEvidence(
      v.finishedAtMs === null || v.startedAtMs === null || v.finishedAtMs >= v.startedAtMs,
      "event_time_order"
    );
    requireEvidence(
      v.skippedOrdinalStart === undefined ||
        (v.outcome === "SKIPPED" && v.skippedOrdinalEnd >= v.skippedOrdinalStart),
      "skipped_range"
    );
    requireEvidence(
      Buffer.byteLength(JSON.stringify(v)) <= DIAGNOSTIC_DEFAULTS.eventLimitBytes,
      "event_size"
    );
  }
  if (v.contractVersion === "measurement-expectation.v1") {
    requireEvidence(
      !["INAPPLICABLE", "UNSUPPORTED"].includes(v.applicability) ||
        (v.applicabilityReason && v.evidenceRefs.length),
      "applicability_proof"
    );
    for (const view of v.consumingViews)
      requireEvidence(
        ["SUMMARY", "COMPARISON"].includes(view.consumer)
          ? Boolean(view.definitionRef) && !view.dashboardUid && !view.panelId
          : Boolean(view.dashboardUid && view.panelId) && !view.definitionRef,
        "consuming_view_identity"
      );
    const interval = v.controllerCadenceMs ?? v.sourceCadenceMs ?? v.scrapeCadenceMs;
    requireEvidence(
      interval !== null && v.expectedSlots === Math.ceil((v.endMs - v.startMs) / interval),
      "independent_slot_count"
    );
  }
  if (v.contractVersion === "measurement-finding.v1") {
    requireEvidence(
      !["LEGITIMATE_LIMITATION", "EXPIRED"].includes(v.classification) || v.evidenceRefs.length,
      "finding_proof"
    );
    const states = [
      "OPEN",
      "REPRODUCED",
      "CAUSE_DEMONSTRATED",
      "CORRECTED",
      "REGRESSION_PASSED",
      "CONFIRMED"
    ];
    requireEvidence(states.indexOf(v.state) < 2 || v.causeRef, "cause_proof");
    requireEvidence(states.indexOf(v.state) < 3 || v.correctionRef, "correction_proof");
    requireEvidence(states.indexOf(v.state) < 4 || v.regressionRefs?.length, "regression_proof");
  }
  if (v.contractVersion === "measurement-diagnostics-budget.v1") {
    requireEvidence(
      new Set(v.reservations.map((r) => r.reservationId)).size === v.reservations.length,
      "duplicate_reservation"
    );
    for (const kind of ["Summary", "Trace"]) {
      const reserved = v.reservations.reduce((n, r) => n + r[`${kind.toLowerCase()}Bytes`], 0);
      requireEvidence(
        v[`committed${kind}Bytes`] + reserved <= v[`${kind.toLowerCase()}LimitBytes`],
        "budget_exceeded"
      );
    }
  }
  if (v.contractVersion === "measurement-diagnostics-retention.v1")
    requireEvidence(
      v.action === "EXPIRED"
        ? v.removedAtMs !== null && v.removedAtMs <= v.recordedAtMs
        : v.removedAtMs === null,
      "removal_time"
    );
  if (v.contractVersion === "measurement-query-evidence.v1") {
    requireEvidence(
      v.runIds.includes(v.runId) && new Set(v.runIds).size === v.runIds.length,
      "query_run_scope"
    );
    requireEvidence(
      v.requestedEndMs >= v.requestedStartMs && v.effectiveEndMs >= v.effectiveStartMs,
      "query_window"
    );
    requireEvidence(
      v.sourceTimestampMinMs === null || v.sourceTimestampMaxMs >= v.sourceTimestampMinMs,
      "source_time_bounds"
    );
  }
  if (v.contractVersion === "measurement-diagnostics.v1") {
    requireEvidence(
      v.parentDiagnosticAttemptId === undefined ||
        v.parentDiagnosticAttemptId !== v.diagnosticAttemptId,
      "manifest_parent_identity"
    );
    validateMeasurementEvidence(v.budgetSnapshot);
    freezeDiagnosticsConfig(
      { contractVersion: v.config.contractVersion, mode: v.config.mode },
      v.config,
      v.config.frozenAtMs
    );
    requireEvidence(
      new Set(v.artifactIndex.map((a) => a.artifactId)).size === v.artifactIndex.length,
      "duplicate_artifact"
    );
    requireEvidence(
      new Set(v.producers.map((p) => p.componentInstanceId)).size === v.producers.length,
      "duplicate_producer"
    );
    requireEvidence(
      v.budgetSnapshot.accountingState !== "UNCONFIRMED" || v.recordingState === "UNAVAILABLE",
      "unknown_budget_state"
    );
    requireEvidence(
      v.runId === v.budgetSnapshot.runId && v.runBudgetId === v.budgetSnapshot.runBudgetId,
      "manifest_budget_owner"
    );
    requireEvidence(
      v.recordingState !== "RECORDING" ? v.finalizedAtMs !== null : v.finalizedAtMs === null,
      "manifest_terminal_time"
    );
    if (v.recordingState === "SEALED")
      requireEvidence(
        v.producers.length > 0 &&
          !v.inventoryIncomplete &&
          !v.findingsIncomplete &&
          !v.droppedEvents &&
          !v.writeFailures &&
          v.budgetSnapshot.accountingState === "CONFIRMED" &&
          v.producers.every(
            (p) =>
              p.flushState === "COMPLETE" &&
              p.collectionStatus === "COMPLETE" &&
              p.budgetAccountingState === "CONFIRMED" &&
              !p.droppedEvents &&
              !p.writeFailures &&
              !p.droppedMetadataRecords &&
              !p.unconfirmedEvents &&
              !p.lostSequenceRangesIncomplete &&
              !p.lostSequenceRanges?.length
          ),
        "sealed_incomplete"
      );
    requireEvidence(
      v.summaryBytes <= v.budgetSnapshot.summaryLimitBytes &&
        v.traceBytes <= v.budgetSnapshot.traceLimitBytes,
      "manifest_size"
    );
  }
  if (v.contractVersion === "measurement-campaign.v1") {
    const configurationIds = new Set(v.configurations.map((c) => c.configurationId));
    requireEvidence(configurationIds.size === v.configurations.length, "duplicate_configuration");
    requireEvidence(
      new Set(v.attempts.map((a) => a.attemptId)).size === v.attempts.length &&
        new Set(v.attempts.map((a) => a.runId)).size === v.attempts.length,
      "duplicate_attempt"
    );
    for (const c of v.configurations) {
      freezeDiagnosticsConfig(
        { contractVersion: c.diagnostics.contractVersion, mode: c.diagnostics.mode },
        c.diagnostics,
        c.diagnostics.frozenAtMs
      );
      requireEvidence(
        c.setup === "NONE" ? c.setupRef === null : c.setupRef !== null,
        "setup_reference"
      );
    }
    for (const a of v.attempts) {
      requireEvidence(configurationIds.has(a.configurationId), "attempt_configuration");
      if (a.assessment === "ACCEPTED")
        requireEvidence(
          a.origin === "LIVE" &&
            a.runState === "SUCCEEDED" &&
            a.measurementValidity === "VALID" &&
            a.cleanupState === "COMPLETE" &&
            a.diagnosticCompleteness === "COMPLETE" &&
            a.sourceAuditRefs.length &&
            a.summaryAuditRefs.length &&
            a.chartRefs.length &&
            !a.reasonCodes.length,
          "accepted_without_evidence"
        );
    }
    requireEvidence(v.updatedAtMs >= v.createdAtMs, "campaign_time");
    if (v.state === "PASSED") validateCampaignPass(v);
  }
  return structuredClone(v) as T;
}
export function measurementSlotId(slot: DiagnosticSlot): string {
  for (const key of ["runId", "diagnosticAttemptId", "phase", "observerId", "slotRuleVersion"])
    requireEvidence(typeof slot[key] === "string" && slot[key].length > 0, "slot_identity");
  requireEvidence(
    Number.isFinite(slot.cadenceMs) &&
      slot.cadenceMs > 0 &&
      Number.isSafeInteger(slot.ordinal) &&
      slot.ordinal >= 0,
    "slot_ordinal"
  );
  return JSON.stringify([
    slot.runId,
    slot.diagnosticAttemptId,
    slot.phase,
    slot.observerId,
    slot.slotRuleVersion,
    slot.cadenceMs,
    slot.ordinal
  ]);
}
export function transitionFinding(from: FindingState, to: FindingState): FindingState {
  const states: FindingState[] = [
    "OPEN",
    "REPRODUCED",
    "CAUSE_DEMONSTRATED",
    "CORRECTED",
    "REGRESSION_PASSED",
    "CONFIRMED"
  ];
  requireEvidence(
    states.includes(from) &&
      states.includes(to) &&
      (to === "OPEN" || states.indexOf(to) === states.indexOf(from) + 1),
    "finding_transition"
  );
  return to;
}
export function validateEvidenceSequence(events: unknown[]): void {
  const ids = new Set<string>(),
    sequences = new Set<string>();
  for (const raw of events) {
    const e = validateMeasurementEvidence<ObservationEvidence>(raw);
    const key = JSON.stringify([
      e.runId,
      e.diagnosticAttemptId,
      e.component,
      e.componentInstanceId,
      e.sequence
    ]);
    requireEvidence(!ids.has(e.eventId) && !sequences.has(key), "duplicate_evidence");
    ids.add(e.eventId);
    sequences.add(key);
  }
}
export function reserveDiagnosticBudget(
  input: RunBudgetLedger,
  reservation: DiagnosticReservation
): RunBudgetLedger {
  const ledger = validateMeasurementEvidence<RunBudgetLedger>(input);
  requireEvidence(ledger.accountingState === "CONFIRMED", "budget_unconfirmed");
  ledger.reservations.push(structuredClone(reservation));
  ledger.revision++;
  return validateMeasurementEvidence(ledger);
}
export function settleDiagnosticBudget(
  input: RunBudgetLedger,
  reservationId: string,
  summaryBytes: number,
  traceBytes: number,
  quiescent: boolean
): RunBudgetLedger {
  const ledger = validateMeasurementEvidence<RunBudgetLedger>(input);
  const r = ledger.reservations.find((r) => r.reservationId === reservationId);
  requireEvidence(
    quiescent &&
      r &&
      Number.isSafeInteger(summaryBytes) &&
      summaryBytes >= 0 &&
      Number.isSafeInteger(traceBytes) &&
      traceBytes >= 0 &&
      summaryBytes <= r.summaryBytes &&
      traceBytes <= r.traceBytes,
    "reservation_reconciliation"
  );
  ledger.committedSummaryBytes += summaryBytes;
  ledger.committedTraceBytes += traceBytes;
  ledger.reservations = ledger.reservations.filter((r) => r.reservationId !== reservationId);
  ledger.revision++;
  return validateMeasurementEvidence(ledger);
}
export function validateBudgetProgress(before: RunBudgetLedger, after: RunBudgetLedger): void {
  validateMeasurementEvidence(before);
  validateMeasurementEvidence(after);
  requireEvidence(
    before.runId === after.runId &&
      before.runBudgetId === after.runBudgetId &&
      before.summaryLimitBytes === after.summaryLimitBytes &&
      before.traceLimitBytes === after.traceLimitBytes &&
      after.committedSummaryBytes >= before.committedSummaryBytes &&
      after.committedTraceBytes >= before.committedTraceBytes &&
      after.revision > before.revision,
    "budget_refill_or_identity"
  );
}
export function projectDetailAvailability(
  present: boolean,
  target: { runId: string; attemptId: string; artifactId: string },
  events: unknown[]
): "AVAILABLE" | "EXPIRED" | "UNAVAILABLE" {
  const pins = new Set<string>();
  let requested = false,
    expired = false;
  const ids = new Set<string>(),
    seq = new Set<number>();
  let previousSequence = -1;
  for (const raw of events) {
    const e = validateMeasurementEvidence<RetentionEvent>(raw);
    requireEvidence(
      e.runId === target.runId &&
        !ids.has(e.eventId) &&
        !seq.has(e.sequence) &&
        e.sequence > previousSequence,
      "retention_identity"
    );
    ids.add(e.eventId);
    seq.add(e.sequence);
    previousSequence = e.sequence;
    if (e.targetArtifactId !== target.artifactId) continue;
    requireEvidence(e.targetAttemptId === target.attemptId, "retention_owner");
    if (e.action === "PIN") {
      requireEvidence(!expired && !requested, "pin_after_removal");
      pins.add(e.findingRef ?? "operator");
    }
    if (e.action === "UNPIN") pins.delete(e.findingRef ?? "operator");
    if (e.action === "EXPIRE_REQUESTED") {
      requireEvidence(!pins.size && !expired, "retention_pinned");
      requested = true;
    }
    if (e.action === "EXPIRE_FAILED") {
      requireEvidence(requested && !expired, "expiry_without_intent");
      requested = false;
    }
    if (e.action === "EXPIRED") {
      requireEvidence(requested && !pins.size && !expired, "expiry_without_intent");
      expired = true;
    }
  }
  requireEvidence(!(expired && present), "expired_artifact_still_present");
  return present ? "AVAILABLE" : expired ? "EXPIRED" : "UNAVAILABLE";
}

export function canonicalDimensions(dimensions: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
}
function validateCampaignPass(campaign: MeasurementCampaign) {
  requireEvidence(
    campaign.mode === "CONFIRM" &&
      campaign.configurations.length >= 4 &&
      campaign.expectationRefs.length &&
      campaign.evidenceRefs.length,
    "campaign_pass_proof"
  );
  for (const workload of ["READ_ONLY", "MIXED"])
    for (const setup of ["NONE", "ORDERED"])
      requireEvidence(
        campaign.configurations.some((c) => c.workloadClass === workload && c.setup === setup),
        "missing_base_configuration"
      );
  const baseIds = new Set<string>();
  for (const workload of ["READ_ONLY", "MIXED"])
    for (const setup of ["NONE", "ORDERED"])
      baseIds.add(
        campaign.configurations.find((c) => c.workloadClass === workload && c.setup === setup)!
          .configurationId
      );
  let baseAccepted = 0;
  for (const config of campaign.configurations) {
    const attempts = campaign.attempts.filter((a) => a.configurationId === config.configurationId);
    let count = 0;
    for (const attempt of attempts)
      count =
        attempt.assessment === "ACCEPTED" && attempt.revision === campaign.revision ? count + 1 : 0;
    const base = baseIds.has(config.configurationId);
    if (base) baseAccepted += count;
    requireEvidence(count >= (base ? 1 : 3), "campaign_consecutive_passes");
  }
  requireEvidence(baseAccepted >= 5, "campaign_five_base_passes");
}
export function validateCampaignProgress(
  before: MeasurementCampaign,
  after: MeasurementCampaign
): void {
  validateMeasurementEvidence(before);
  validateMeasurementEvidence(after);
  requireEvidence(
    before.campaignId === after.campaignId &&
      before.createdAtMs === after.createdAtMs &&
      after.attempts.length >= before.attempts.length,
    "campaign_identity"
  );
  for (let i = 0; i < before.attempts.length; i++)
    requireEvidence(
      JSON.stringify(before.attempts[i]) === JSON.stringify(after.attempts[i]),
      "immutable_attempt_ledger"
    );
  const allowed = {
    DRAFT: ["DECLARED"],
    DECLARED: ["RUNNING", "BLOCKED"],
    RUNNING: ["ASSESSING", "BLOCKED"],
    ASSESSING: ["PASSED", "NEEDS_INVESTIGATION", "BLOCKED"],
    NEEDS_INVESTIGATION: ["DECLARED"],
    BLOCKED: ["DECLARED"],
    PASSED: []
  };
  requireEvidence(
    before.state === after.state || allowed[before.state].includes(after.state),
    "campaign_transition"
  );
  if (before.state !== "DRAFT" && after.state !== "DECLARED")
    requireEvidence(
      JSON.stringify(before.configurations) === JSON.stringify(after.configurations) &&
        before.revision === after.revision,
      "frozen_campaign_configuration"
    );
}

/** Internal frozen container handoff; never accepted as a scheduling request. */
export interface MeasurementProducerConfig {
  contractVersion: "measurement-diagnostics-producer.v1";
  runId: string;
  experimentId: string;
  diagnosticAttemptId: string;
  runBudgetId: string;
  component: string;
  config: FrozenDiagnosticsConfig;
  summaryBytes: number;
  traceBytes: number;
  pendingLimitBytes: number;
}
export function validateMeasurementProducerConfig(input: unknown): MeasurementProducerConfig {
  const value = input as MeasurementProducerConfig;
  const keys = [
    "contractVersion",
    "runId",
    "experimentId",
    "diagnosticAttemptId",
    "runBudgetId",
    "component",
    "config",
    "summaryBytes",
    "traceBytes",
    "pendingLimitBytes"
  ];
  requireEvidence(
    value &&
      typeof value === "object" &&
      Object.keys(value).length === keys.length &&
      Object.keys(value).every((key) => keys.includes(key)) &&
      value.contractVersion === "measurement-diagnostics-producer.v1",
    "producer_config_shape"
  );
  for (const key of ["runId", "experimentId", "diagnosticAttemptId", "runBudgetId", "component"])
    requireEvidence(
      typeof value[key] === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value[key]),
      "producer_identity"
    );
  requireEvidence(ajv.validate(frozenSchema, value.config), "producer_frozen_config");
  freezeDiagnosticsConfig(
    { contractVersion: value.config.contractVersion, mode: value.config.mode },
    value.config,
    value.config.frozenAtMs
  );
  for (const [field, limit] of [
    ["summaryBytes", value.config.summaryLimitBytes],
    ["traceBytes", value.config.traceLimitBytes],
    ["pendingLimitBytes", value.config.pendingLimitBytes]
  ] as const)
    requireEvidence(
      Number.isSafeInteger(value[field]) &&
        value[field] >= (field === "traceBytes" ? 0 : field === "summaryBytes" ? 2048 : 1024) &&
        value[field] <= limit,
      "producer_allocation"
    );
  requireEvidence(
    value.pendingLimitBytes >= value.config.eventLimitBytes &&
      (value.config.mode !== "summary" || value.traceBytes === 0),
    "producer_mode_bounds"
  );
  return structuredClone(value);
}
