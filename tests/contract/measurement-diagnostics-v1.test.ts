import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMeasurementDiagnostics,
  validateMeasurementEvidence,
  measurementSlotId,
  transitionFinding,
  validateEvidenceSequence,
  projectDetailAvailability,
  reserveDiagnosticBudget,
  settleDiagnosticBudget,
  validateBudgetProgress
} from "../../packages/contracts/src/measurement-diagnostics";
const ledger = () => ({
  contractVersion: "measurement-diagnostics-budget.v1",
  runId: "run-1",
  runBudgetId: "budget-1",
  summaryLimitBytes: 8192,
  traceLimitBytes: 16384,
  committedSummaryBytes: 0,
  committedTraceBytes: 0,
  reservations: [],
  accountingState: "CONFIRMED",
  revision: 0
});
const event = () => ({
  contractVersion: "measurement-observation.v1",
  eventId: "e1",
  runId: "run-1",
  experimentId: "experiment-1",
  diagnosticAttemptId: "a1",
  component: "controller",
  componentInstanceId: "i1",
  sequence: 0,
  stage: "HTTP",
  outcome: "SUCCEEDED",
  scheduledAtMs: null,
  startedAtMs: 100,
  finishedAtMs: 101,
  sourceCapturedAtMs: null,
  availableAtMs: 101,
  timestampOrigin: "UNKNOWN",
  durationMs: 1,
  queueWaitMs: 0,
  bodyReadMs: 0,
  callerRole: "UNKNOWN"
});
const retention = (action = "EXPIRED") => ({
  contractVersion: "measurement-diagnostics-retention.v1",
  eventId: "retention-1",
  runId: "run-1",
  sequence: 0,
  recordedAtMs: 1000,
  action,
  targetAttemptId: "a1",
  targetArtifactId: "artifact-1",
  reasonCode: "ttl_elapsed",
  removedAtMs: action === "EXPIRED" ? 999 : null
});
test("omission and explicit summary have the same canonical configuration; strict mode validation", () => {
  assert.deepEqual(
    normalizeMeasurementDiagnostics(undefined),
    normalizeMeasurementDiagnostics({
      contractVersion: "measurement-diagnostics-config.v1",
      mode: "summary"
    })
  );
  for (const input of [
    {},
    { contractVersion: "measurement-diagnostics-config.v2", mode: "summary" },
    { contractVersion: "measurement-diagnostics-config.v1", mode: "off" },
    { contractVersion: "measurement-diagnostics-config.v1", mode: "trace", traceLimitBytes: 5 }
  ])
    assert.throws(() => normalizeMeasurementDiagnostics(input));
});
test("observation timestamps retain unknown provenance, reject values, invalid times, unbounded detail and unknown versions", () => {
  assert.equal(validateMeasurementEvidence(event()).sourceCapturedAtMs, null);
  for (const patch of [
    { value: 5 },
    { durationMs: -1 },
    { sourceCapturedAtMs: 1, timestampOrigin: "UNKNOWN" },
    { stage: "SECRET" },
    { contractVersion: "measurement-observation.v2" },
    { reasonCodes: ["x".repeat(4097)] }
  ])
    assert.throws(() => validateMeasurementEvidence({ ...event(), ...patch }));
});
test("slot identities preserve run, attempt, phase, observer, rule, cadence and ordinal", () => {
  const slot = {
    runId: "r",
    diagnosticAttemptId: "a",
    phase: "measurement",
    observerId: "o",
    slotRuleVersion: "phase-start.v1",
    cadenceMs: 5000,
    ordinal: 0
  };
  const id = measurementSlotId(slot);
  for (const patch of [
    { runId: "r2" },
    { diagnosticAttemptId: "a2" },
    { phase: "warmup" },
    { observerId: "o2" },
    { cadenceMs: 1000 },
    { ordinal: 1 }
  ])
    assert.notEqual(measurementSlotId({ ...slot, ...patch }), id);
  assert.throws(() => measurementSlotId({ ...slot, ordinal: -1 }));
});
test("duplicate evidence and component sequences cannot inflate acquisitions", () => {
  assert.doesNotThrow(() =>
    validateEvidenceSequence([event(), { ...event(), eventId: "e2", componentInstanceId: "i2" }])
  );
  assert.throws(() => validateEvidenceSequence([event(), event()]));
  assert.throws(() => validateEvidenceSequence([event(), { ...event(), eventId: "e2" }]));
});
test("causal state transitions cannot jump proof gates, and invalidated proof reopens", () => {
  assert.equal(transitionFinding("OPEN", "REPRODUCED"), "REPRODUCED");
  assert.throws(() => transitionFinding("OPEN", "CONFIRMED"));
  assert.equal(transitionFinding("REGRESSION_PASSED", "OPEN"), "OPEN");
});
test("retention absence is unavailable unless completed expiry proves removal; ownership is enforced", () => {
  const target = { runId: "run-1", attemptId: "a1", artifactId: "artifact-1" };
  assert.equal(projectDetailAvailability(false, target, []), "UNAVAILABLE");
  assert.equal(
    projectDetailAvailability(false, target, [retention("EXPIRE_REQUESTED")]),
    "UNAVAILABLE"
  );
  assert.equal(
    projectDetailAvailability(false, target, [
      { ...retention("EXPIRE_REQUESTED"), eventId: "intent" },
      { ...retention(), sequence: 1 }
    ]),
    "EXPIRED"
  );
  assert.throws(() =>
    projectDetailAvailability(false, target, [{ ...retention(), runId: "other" }])
  );
  assert.throws(() => validateMeasurementEvidence({ ...retention(), removedAtMs: null }));
  assert.throws(() => projectDetailAvailability(false, target, [retention()]));
});
test("shared lifetime budget reserves atomically, settles only quiescent producers, never refunds committed usage", () => {
  const initial = validateMeasurementEvidence(ledger());
  const a = reserveDiagnosticBudget(initial, {
    reservationId: "p1",
    attemptId: "a1",
    producerId: "controller",
    summaryBytes: 4096,
    traceBytes: 8192
  });
  assert.equal(initial.reservations.length, 0);
  assert.throws(() =>
    reserveDiagnosticBudget(a, {
      reservationId: "p2",
      attemptId: "a2",
      producerId: "controller",
      summaryBytes: 4097,
      traceBytes: 0
    })
  );
  assert.throws(() => settleDiagnosticBudget(a, "p1", 100, 100, false));
  const b = settleDiagnosticBudget(a, "p1", 4096, 8192, true);
  assert.equal(b.committedTraceBytes, 8192);
  assert.throws(() =>
    validateBudgetProgress(b, { ...b, committedTraceBytes: 0, revision: b.revision + 1 })
  );
  assert.throws(() =>
    validateBudgetProgress(b, { ...b, traceLimitBytes: 32768, revision: b.revision + 1 })
  );
  assert.throws(() =>
    reserveDiagnosticBudget(
      { ...b, accountingState: "UNCONFIRMED" },
      {
        reservationId: "p2",
        attemptId: "a2",
        producerId: "controller",
        summaryBytes: 1,
        traceBytes: 0
      }
    )
  );
  assert.throws(() =>
    validateMeasurementEvidence({ ...ledger(), traceLimitBytes: 129 * 1024 * 1024 })
  );
});
test("expectations require independent applicability proof and independent slot counts", () => {
  const input = {
    contractVersion: "measurement-expectation.v1",
    expectationId: "expectation-1",
    runId: "run-1",
    definitionId: "cpu",
    semanticVersion: "1",
    statistic: "Avg",
    scope: "platform",
    dimensions: { service: "database" },
    sourceKind: "resource",
    publisher: "cadvisor",
    phase: "measurement",
    startMs: 0,
    endMs: 10000,
    sourceCadenceMs: null,
    controllerCadenceMs: 5000,
    scrapeCadenceMs: 1000,
    qualityRequirement: "optional",
    applicability: "EXPECTED",
    applicabilityReason: null,
    evidenceRefs: [],
    slotRuleVersion: "phase-start.v1",
    expectedSlots: 2,
    consumingViews: []
  };
  assert.doesNotThrow(() => validateMeasurementEvidence(input));
  assert.throws(() => validateMeasurementEvidence({ ...input, applicability: "INAPPLICABLE" }));
  assert.throws(() => validateMeasurementEvidence({ ...input, expectedSlots: 1 }));
  assert.throws(() => validateMeasurementEvidence({ ...input, sourceCadenceMs: 0 }));
});
test("legacy missing diagnostics remains NOT_RECORDED and unknown shapes never become evidence", () => {
  assert.equal(validateMeasurementEvidence(undefined).recordingState, "NOT_RECORDED");
  assert.throws(() => validateMeasurementEvidence({ contractVersion: "made-up.v1" }));
});

test("query evidence distinguishes raw captures from grids, preserves exact scope and rejects response arrays", () => {
  const query = {
    contractVersion: "measurement-query-evidence.v1",
    runId: "run-1",
    diagnosticAttemptId: "a1",
    queryId: "q1",
    consumer: "FINALIZATION",
    mode: "RAW_STORED_SAMPLES",
    runIds: ["run-1"],
    source: "cadvisor",
    definitionId: "disk_bytes",
    semanticVersion: "1",
    dimensions: { service: "database", direction: "read" },
    expectedMemberIds: Array.from({ length: 129 }, (_, n) => `member-${n}`),
    selectorRef: "selector-1",
    expectationRefs: ["expectation-1"],
    requestedStartMs: 0,
    requestedEndMs: 10000,
    effectiveStartMs: 0,
    effectiveEndMs: 10000,
    stepMs: null,
    nativeCadenceMs: null,
    scrapeCadenceMs: 5000,
    lookbackMs: null,
    transforms: [],
    counterEdgePolicy: null,
    queueWaitMs: 0,
    durationMs: 1,
    bodyReadMs: 0,
    requestCount: 1,
    pageCount: 1,
    responseBytes: 100,
    outcome: "SUCCEEDED",
    retryLevel: 0,
    seriesCount: 128,
    memberCount: 128,
    sampleCount: 256,
    sourceTimestampMinMs: 0,
    sourceTimestampMaxMs: 9999,
    duplicateCount: 0,
    conflictCount: 0,
    resetCount: 0,
    epochCount: 128,
    reasonCodes: ["required_member_missing"],
    missingMemberIds: ["member-128"],
    projections: [],
    cache: "NONE",
    publicationOutcome: null,
    inventoryIncomplete: false
  };
  assert.equal(validateMeasurementEvidence(query).expectedMemberIds.length, 129);
  assert.equal(
    validateMeasurementEvidence({ ...query, mode: "EVALUATION_GRID", stepMs: 1000 }).mode,
    "EVALUATION_GRID"
  );
  for (const patch of [
    { runIds: ["other"] },
    { response: [1, 2] },
    { mode: "RAW" },
    { sampleCount: -1 },
    { sourceTimestampMinMs: 20000 },
    { effectiveEndMs: -1 }
  ])
    assert.throws(() => validateMeasurementEvidence({ ...query, ...patch }));
});

test("sealed manifests require terminal producers, complete inventory, frozen ownership and honest accounting", () => {
  const frozen = {
    contractVersion: "measurement-diagnostics-config.v1",
    mode: "summary",
    summaryLimitBytes: 8388608,
    traceLimitBytes: 33554432,
    pendingLimitBytes: 1048576,
    eventLimitBytes: 4096,
    flushIntervalMs: 1000,
    traceTtlMs: 604800000,
    retainedTraceLimitBytes: 1073741824,
    frozenAtMs: 0,
    retentionControlBytes: 65536
  };
  const budget = {
    ...ledger(),
    summaryLimitBytes: frozen.summaryLimitBytes,
    traceLimitBytes: frozen.traceLimitBytes
  };
  const producer = {
    component: "controller",
    componentInstanceId: "i1",
    reservationId: "p1",
    summaryBytes: 1000,
    traceBytes: 0,
    sequenceStart: 0,
    sequenceEnd: 0,
    attemptedEvents: 1,
    retainedEvents: 1,
    droppedEvents: 0,
    writeFailures: 0,
    flushState: "COMPLETE",
    budgetAccountingState: "CONFIRMED",
    collectionStatus: "COMPLETE"
  };
  const manifest = {
    contractVersion: "measurement-diagnostics.v1",
    runId: "run-1",
    experimentId: "experiment-1",
    diagnosticAttemptId: "a1",
    config: frozen,
    createdAtMs: 0,
    finalizedAtMs: 10,
    recordingState: "SEALED",
    deployedRefs: {},
    phaseRefs: [],
    cadenceRefs: [],
    producers: [producer],
    inventoryPages: [],
    findingPages: [],
    queryRefs: [],
    artifactIndex: [],
    stageAggregates: [],
    summaryBytes: 1000,
    traceBytes: 0,
    droppedEvents: 0,
    writeFailures: 0,
    inventoryIncomplete: false,
    findingsIncomplete: false,
    runBudgetId: "budget-1",
    budgetSnapshot: budget
  };
  assert.doesNotThrow(() => validateMeasurementEvidence(manifest));
  for (const patch of [
    { finalizedAtMs: null },
    { inventoryIncomplete: true },
    { producers: [] },
    { droppedEvents: 1 },
    { producers: [{ ...producer, flushState: "UNCONFIRMED" }] },
    { budgetSnapshot: { ...budget, runId: "other" } },
    { budgetSnapshot: { ...budget, accountingState: "UNCONFIRMED" } },
    { config: { ...frozen, summaryLimitBytes: 1 } }
  ])
    assert.throws(() => validateMeasurementEvidence({ ...manifest, ...patch }));
  assert.equal(
    validateMeasurementEvidence({
      ...manifest,
      recordingState: "UNAVAILABLE",
      budgetSnapshot: { ...budget, accountingState: "UNCONFIRMED" }
    }).recordingState,
    "UNAVAILABLE"
  );
});

test("findings cannot call missing evidence a limitation or skip causal proof", () => {
  const finding = {
    contractVersion: "measurement-finding.v1",
    findingId: "f1",
    runId: "run-1",
    expectationId: "expectation-1",
    symptom: "missing member",
    startMs: 0,
    endMs: 10,
    lastConfirmedStage: null,
    classification: "UNRESOLVED",
    reasonCode: "missing_evidence",
    evidenceRefs: [],
    hypothesisIds: [],
    state: "OPEN",
    coverage: {},
    missingMemberIds: ["pas-1"],
    nativeAvailability: null
  };
  assert.equal(validateMeasurementEvidence(finding).classification, "UNRESOLVED");
  assert.throws(() =>
    validateMeasurementEvidence({ ...finding, classification: "LEGITIMATE_LIMITATION" })
  );
  assert.throws(() =>
    validateMeasurementEvidence({
      ...finding,
      classification: "DEFECT",
      state: "REGRESSION_PASSED",
      causeRef: "cause-1",
      correctionRef: "fix-1"
    })
  );
});

test("observation count fields are fixed metadata, not an escape hatch for raw values", () => {
  assert.throws(() => validateMeasurementEvidence({ ...event(), counts: { value: 123 } }));
  assert.doesNotThrow(() => validateMeasurementEvidence({ ...event(), counts: { validSamples: 129, responseBytes: 8192 } }));
});
