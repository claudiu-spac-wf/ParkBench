import test from "node:test";
import assert from "node:assert/strict";
import {
  DATABASE_IOPS_CATALOG,
  resolveDatabaseIops,
  validateDatabaseIopsCondition,
  validateDatabaseIopsCoverage,
  validateDatabaseIopsIntent,
  validateDatabaseIopsEvidence,
  acceptIopsTermination
} from "../../packages/contracts/src/database-iops";
import { iopsCoverage } from "../fixtures/database-iops";
test("five fixed directional/device caps and honest legacy absence", () => {
  assert.deepEqual(
    DATABASE_IOPS_CATALOG.presets.map((p) => [p.id, p.readIopsPerDevice, p.writeIopsPerDevice]),
    [
      ["hdd", 150, 150],
      ["sata-ssd", 90000, 90000],
      ["slow-nvme", 250000, 250000],
      ["fast-nvme", 1000000, 1000000],
      ["unlimited", null, null]
    ]
  );
  assert.equal(resolveDatabaseIops().presetId, "unlimited");
  for (const id of ["", "unknown", 150, null]) assert.throws(() => resolveDatabaseIops(id));
  for (const patch of [
    { readIopsPerDevice: 0 },
    { writeIopsPerDevice: null },
    { catalogVersion: "future" },
    { label: "fast" },
    { readIopsPerDevice: NaN },
    { extra: true }
  ])
    assert.throws(() => validateDatabaseIopsCondition({ ...resolveDatabaseIops("hdd"), ...patch }));
  assert.ok(Object.isFrozen(resolveDatabaseIops("hdd")));
});
test("complete bounded coverage and owner identity, never a 128-device truncation", () => {
  assert.equal(validateDatabaseIopsCoverage(iopsCoverage(129)).devices.length, 129);
  for (const c of [
    iopsCoverage(0),
    iopsCoverage(4097),
    { ...iopsCoverage(), owner: { ...iopsCoverage().owner, pid: 0 } },
    { ...iopsCoverage(), devices: [{ ...iopsCoverage().devices[0], paths: ["/seed/private"] }] }
  ])
    assert.throws(() => validateDatabaseIopsCoverage(c));
});
test("immutable intent and terminal decision survive JSON storage", () => {
  const coverage = iopsCoverage();
  const condition = resolveDatabaseIops("hdd");
  const rules = {
    read: [{ Path: "/dev/fixture0", Rate: 150 }],
    write: [{ Path: "/dev/fixture0", Rate: 150 }]
  };
  const intent = validateDatabaseIopsIntent({
    contractVersion: "database-iops-application-intent.v1",
    attemptId: "attempt-1",
    experimentId: "experiment-1",
    runId: coverage.owner.runId,
    variantId: "variant-1",
    preparedAt: new Date().toISOString(),
    condition,
    owner: coverage.owner,
    coverage,
    previousIops: { read: [], write: [] },
    desiredIops: rules
  });
  assert.ok(Object.isFrozen(intent.coverage.devices));
  assert.throws(() => validateDatabaseIopsIntent({ ...intent, runId: "wrong" }));
  assert.throws(() =>
    validateDatabaseIopsIntent({ ...intent, desiredIops: { ...rules, write: [] } })
  );
  const evidence: any = {
    contractVersion: "database-iops-evidence.v1",
    condition,
    stage: "PERSISTING_INTENT",
    verification: { status: "PENDING", checks: 0 },
    applicationIntent: intent
  };
  acceptIopsTermination(evidence, "POLICY_DRIFT", "measurement");
  acceptIopsTermination(evidence, "CANCELLED", "measurement");
  assert.equal(
    validateDatabaseIopsEvidence(JSON.parse(JSON.stringify(evidence))).terminationDecision.cause,
    "POLICY_DRIFT"
  );
  const cancelled: any = { ...evidence, terminationDecision: undefined };
  acceptIopsTermination(cancelled, "CANCELLED", "warmup");
  acceptIopsTermination(cancelled, "POLICY_DRIFT", "warmup");
  assert.equal(cancelled.terminationDecision.cause, "CANCELLED");
  assert.throws(() =>
    validateDatabaseIopsEvidence({ ...evidence, verification: { status: "OK", checks: 0 } })
  );
  assert.throws(() =>
    validateDatabaseIopsEvidence({
      ...evidence,
      terminationDecision: {
        cause: "SUCCESS",
        acceptedAt: new Date().toISOString(),
        phase: "warmup"
      }
    })
  );
});
