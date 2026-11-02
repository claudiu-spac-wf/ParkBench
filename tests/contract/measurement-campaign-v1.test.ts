import test from "node:test";
import assert from "node:assert/strict";
import {
  DIAGNOSTIC_DEFAULTS,
  freezeDiagnosticsConfig,
  validateCampaignProgress,
  validateMeasurementEvidence,
  MeasurementCampaign,
  CampaignAttempt
} from "../../packages/contracts/src/measurement-diagnostics";
const configurations = ["READ_ONLY", "MIXED"].flatMap((workloadClass) =>
  ["NONE", "ORDERED"].map((setup) => ({
    configurationId: `${workloadClass}_${setup}`,
    workloadClass,
    setup,
    scenarioSourceId: "scenario",
    seedRef: "seed",
    archiveRef: "archive",
    setupRef: setup === "NONE" ? null : "idxbuild-all",
    startupParameters: { "-n": 100 },
    phases: {
      warmupSeconds: 60,
      measurementSeconds: workloadClass === "MIXED" ? 300 : 180,
      cooldownSeconds: 30
    },
    concurrency: workloadClass === "MIXED" ? 10 : 35,
    cadencesMs: { observer: 5000 },
    deployedRefs: { controller: "image-1" },
    triggerConditions: [],
    expectationRefs: ["expectation-inventory-1"],
    diagnostics: freezeDiagnosticsConfig(undefined, DIAGNOSTIC_DEFAULTS, 0)
  }))
);
const campaign = () => ({
  contractVersion: "measurement-campaign.v1",
  campaignId: "campaign-1",
  mode: "CONFIRM",
  state: "DRAFT",
  specRef: "024-fix-measurement-gaps",
  revision: "revision-1",
  configurations,
  attempts: [],
  expectationRefs: ["expectation-inventory-1"],
  findingRefs: [],
  evidenceRefs: ["regression-1"],
  createdAtMs: 0,
  updatedAtMs: 0
});
function passing(): MeasurementCampaign {
  const result = campaign();
  result.state = "PASSED";
  for (const [index, c] of configurations.entries())
    for (let n = 0; n < (index === 0 ? 2 : 1); n++)
      result.attempts.push({
        attemptId: `${c.configurationId}-${n}`,
        configurationId: c.configurationId,
        runId: `${c.configurationId}-${n}`,
        revision: "revision-1",
        recordedAtMs: n,
        origin: "LIVE",
        sequenceOrdinal: n,
        assessment: "ACCEPTED",
        runState: "SUCCEEDED",
        measurementValidity: "VALID",
        cleanupState: "COMPLETE",
        diagnosticCompleteness: "COMPLETE",
        sourceAuditRefs: ["source-audit"],
        summaryAuditRefs: ["summary-audit"],
        chartRefs: ["chart"],
        findingRefs: [],
        reasonCodes: [],
        previewRef: "preview",
        submitKey: "submit",
        startKey: "start",
        hypothesisRef: null,
        intendedChangeRef: null,
        observedConditionRefs: [],
        nextAction: "continue"
      });
  return validateMeasurementEvidence(result);
}
test("campaign pass requires five audited fresh base runs covering four combinations", () => {
  assert.equal(passing().attempts.length, 5);
  const rejected = passing();
  rejected.attempts[1].assessment = "REJECTED";
  assert.throws(() => validateMeasurementEvidence(rejected));
  const missing = passing();
  missing.configurations.pop();
  assert.throws(() => validateMeasurementEvidence(missing));
  const shortened = passing();
  shortened.attempts.pop();
  assert.throws(() => validateMeasurementEvidence(shortened));
  for (const origin of ["FIXTURE", "CONTROL", "FAULT", "HISTORICAL"] as const) {
    const c = passing();
    c.attempts[0].origin = origin;
    assert.throws(() => validateMeasurementEvidence(c));
  }
  const chart = passing();
  chart.attempts[0].chartRefs = [];
  assert.throws(() => validateMeasurementEvidence(chart));
});
test("attempt ledger preserves rejected/inconclusive records; changes and state skips fail", () => {
  const before = validateMeasurementEvidence<MeasurementCampaign>(campaign());
  const next = { ...before, state: "DECLARED" as const };
  assert.doesNotThrow(() => validateCampaignProgress(before, next));
  assert.throws(() => validateCampaignProgress(before, { ...before, state: "RUNNING" }));
  const finished = passing();
  finished.state = "ASSESSING";
  const rewrite = structuredClone(finished);
  rewrite.attempts[0].chartRefs = ["replacement"];
  assert.throws(() => validateCampaignProgress(finished, rewrite));
  const fewer = structuredClone(finished);
  fewer.attempts.pop();
  assert.throws(() => validateCampaignProgress(finished, fewer));
  const newRevision = structuredClone(finished);
  newRevision.revision = "revision-2";
  assert.throws(() => validateCampaignProgress(finished, newRevision));
});

test("extra trigger passes cannot substitute for the fifth base run", () => {
  const c = passing();
  const extra = { ...c.configurations[0], configurationId: "actual-trigger" };
  c.configurations.push(extra);
  const [template] = c.attempts.splice(1, 1);
  for (let i = 0; i < 3; i++)
    c.attempts.push({
      ...template,
      attemptId: "extra-" + i,
      runId: "extra-" + i,
      configurationId: extra.configurationId
    });
  assert.throws(() => validateMeasurementEvidence(c));
});
