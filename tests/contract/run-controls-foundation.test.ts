import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv/dist/2020";
import { loadContractSchema } from "../../packages/contracts/src/schema-loader";
import { classifyRunError } from "../../apps/control-plane/src/runs/run-error";

test("run context preserves additive versioned controls and legacy omission", () => {
  const validate = new Ajv({ strict: false }).compile(loadContractSchema("run-context-v1"));
  const context = {
    contractVersion: "run-context.v1",
    runId: "fixture",
    scenario: {},
    requested: {},
    effective: {},
    observed: {},
    inputs: {},
    loadSeed: 1,
    host: {},
    tools: {},
    images: {},
    sources: [],
    capturedAt: "2026-10-03T00:00:00Z"
  };
  assert.equal(validate(context), true);
  const controls = {
    contractVersion: "db-run-controls.v1",
    requested: { apwCount: 0, biwEnabled: false }
  };
  const roundTrip = JSON.parse(JSON.stringify({ ...context, databaseRunControls: controls }));
  assert.equal(validate(roundTrip), true);
  assert.deepEqual(roundTrip.databaseRunControls.requested, { apwCount: 0, biwEnabled: false });
  assert.equal(
    validate({ ...context, databaseRunControls: { contractVersion: "invalid" } }),
    false
  );
});

test("new writer/preparation and named evidence errors are typed before generic readiness", () => {
  for (const code of [
    "database_writer_unavailable",
    "database_writer_capacity_insufficient",
    "database_bi_preparation_failed",
    "database_writer_start_failed",
    "database_run_control_unapplied",
    "database_writer_lost",
    "named_latch_evidence_missing"
  ] as const) {
    const error = classifyRunError(`database_readiness_failed:${code}`);
    assert.equal(error?.failureCode, code);
    assert.equal(
      error?.failureKind,
      code === "named_latch_evidence_missing" ? "observer" : "infrastructure"
    );
  }
  assert.equal(classifyRunError("database_run_control_invalid:apwCount"), undefined);
});
