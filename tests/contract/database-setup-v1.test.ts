import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../../packages/contracts/src";
import { validateMatrixRequest } from "../../packages/contracts/src/matrix-expansion";
import {
  builtinSetup,
  customSetup,
  rawSetupInputs,
  legacySchedule
} from "../fixtures/database-setup/fixtures";
const validate = contracts.validateDatabaseSetup;
test("setup rejects unknown versions, fields and malformed sets instead of silently dropping them", () => {
  for (const input of [
    { contractVersion: "v2", steps: [] },
    { ...builtinSetup, unexpected: true },
    {
      contractVersion: "database-setup.v1",
      steps: [{ id: "s", definitionId: "custom", scriptRef: "input:scripts/a.sh", optionSets: [] }]
    },
    {
      contractVersion: "database-setup.v1",
      steps: [{ id: "s", definitionId: "unknown", optionSets: [{ id: "a" }] }]
    }
  ])
    assert.throws(() => validate(input));
});
test("setup accepts independent scopes, repeated values and exact unrestricted raw text", () => {
  assert.doesNotThrow(() => validate(builtinSetup));
  for (const input of rawSetupInputs) {
    const config = customSetup([input]);
    const source = JSON.stringify(config);
    assert.doesNotThrow(() => validate(config));
    assert.equal(JSON.stringify(config), source);
  }
  assert.doesNotThrow(() => validate({ contractVersion: "database-setup.v1", steps: [] }));
});
test("setup enforces per-parent structural IDs and compaction mode boundaries", () => {
  const config = () => JSON.parse(JSON.stringify(builtinSetup));
  for (const mutate of [
    (c: any) => c.steps.push(c.steps[0]),
    (c: any) => c.steps[0].optionSets.push(c.steps[0].optionSets[0]),
    (c: any) => (c.steps[0].id = "bad/path"),
    (c: any) => (c.steps[0].id = "x".repeat(65)),
    (c: any) => (c.steps[2].optionSets[0].compactionPercent = 49),
    (c: any) => (c.steps[2].optionSets[0].mode = "unusedblocks")
  ]) {
    const c = config();
    mutate(c);
    assert.throws(() => validate(c));
  }
  const custom = customSetup([""]);
  (custom.steps[0].optionSets[0] as any).extra = true;
  assert.throws(() => validate(custom));
});

test("custom evidence cannot mistake parent/shell success for completed owned work", () => {
  const pending = contracts.pendingSetupEvidence(
    "run",
    "attempt",
    contracts.validateDatabaseSetup(customSetup(["x"]))
  );
  assert.doesNotThrow(() => contracts.validateDatabaseSetupEvidence(pending));
  const set = pending.steps[0].optionSets[0];
  Object.assign(set, {
    state: "SUCCEEDED",
    exitStatus: 0,
    primaryInvocationObserved: true,
    primaryExitStatus: 0,
    shellExitStatus: 0,
    processScopeState: "ACTIVE",
    quiescentAt: null
  });
  assert.throws(
    () => contracts.validateDatabaseSetupEvidence(pending),
    /database_setup_evidence_invalid/
  );
  set.processScopeState = "QUIESCENT";
  set.quiescentAt = new Date().toISOString();
  assert.doesNotThrow(() => contracts.validateDatabaseSetupEvidence(pending));
  set.primaryExitStatus = 1;
  assert.throws(() => contracts.validateDatabaseSetupEvidence(pending));
  set.primaryExitStatus = 0;
  set.shellExitStatus = 1;
  assert.throws(() => contracts.validateDatabaseSetupEvidence(pending));
  set.shellExitStatus = null;
  set.state = "RUNNING";
  assert.doesNotThrow(() => contracts.validateDatabaseSetupEvidence(pending));
  for (const code of contracts.DATABASE_SETUP_FAILURE_CODES)
    assert.ok((contracts.RUN_FAILURE_CODES as readonly string[]).includes(code));
});
