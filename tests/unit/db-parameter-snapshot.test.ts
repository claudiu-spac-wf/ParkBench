import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { deriveDatabaseParameterSnapshot } from "../../packages/observers/src/openedge-db/parameter-snapshot";

const fixtures = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), "tests/fixtures/database-parameters/db-params-cases.json"),
    "utf8"
  )
) as Record<string, any>;
const identity = { runId: "run_1", experimentId: "exp_1", variantId: "v1", repetition: 1 };
const startup = {
  contractVersion: "db-startup-parameters.v1" as const,
  databaseName: "parkbench",
  startupFile: { status: "absent" as const },
  parameters: [
    {
      name: "-B",
      displayValue: "1000",
      source: "queued" as const,
      overrides: [],
      applicability: "database_broker" as const,
      verification: "pending" as const
    }
  ]
};

test("user-slot verification retains the observed primary broker slot without rejecting the applied setting", () => {
  for (const [name, expected, observed, verification] of [
    ["-n", "100", "101", "matched"],
    ["-n", "101", "102", "matched"],
    ["-n", "100", "103", "mismatched"],
    ["-B", "100", "101", "mismatched"]
  ]) {
    const snapshot = deriveDatabaseParameterSnapshot(
      {
        contractVersion: "openedge-db-parameter-capture.v1",
        databaseName: "parkbench",
        attemptedAt: "2026-09-30T22:00:00Z",
        capturedAt: "2026-09-30T22:00:00Z",
        source: "_DbParams",
        status: "complete",
        rows: [{ name, rawValue: observed, dtype: 4, isDefault: false }]
      },
      identity,
      { ...startup, parameters: [{ ...startup.parameters[0], name, displayValue: expected }] }
    );
    assert.equal(snapshot.verificationResults[0].verification, verification);
    assert.equal(snapshot.verificationResults[0].observedValue, observed);
    assert.equal(snapshot.rows[0].displayValue, observed);
    if (name === "-n" && expected !== observed && verification === "matched")
      assert.equal(snapshot.verificationResults[0].reason, "openedge_primary_broker_slot");
  }
});

for (const [name, fixture] of Object.entries(fixtures)) {
  test(`snapshot ${name}`, () => {
    const rows = fixture.rows.map((row: any) => {
      if (!row.rawValuePattern) return row;
      const { rawValuePattern, ...rest } = row;
      return { ...rest, rawValue: rawValuePattern.character.repeat(rawValuePattern.count) };
    });
    const capture = {
      contractVersion: "openedge-db-parameter-capture.v1" as const,
      databaseName: "parkbench",
      attemptedAt: "2026-09-28T10:00:00.000Z",
      ...((fixture.status !== "unavailable" && rows.length) || fixture.status === "complete"
        ? { capturedAt: "2026-09-28T10:00:00.000Z" }
        : {}),
      source: "_DbParams" as const,
      status: fixture.status,
      ...(fixture.reason ? { reason: fixture.reason } : {}),
      rows
    };
    const snapshot = deriveDatabaseParameterSnapshot(capture, identity, startup);
    if (name === "complete") {
      assert.equal(snapshot.status, "complete");
      assert.deepEqual(
        snapshot.rows.map((row) => row.name),
        ["-B", "-text"]
      );
      assert.equal(snapshot.rows[0].numericValue, 1000);
      assert.equal(snapshot.rows[1].displayValue, "plain text");
      assert.equal(snapshot.verificationResults[0].verification, "matched");
    }
    if (name === "allDefault" || name === "empty") assert.equal(snapshot.status, "empty");
    if (name === "unknownValue")
      assert.deepEqual(
        [snapshot.rows[0].valueStatus, snapshot.rows[0].displayValue],
        ["unknown", null]
      );
    if (name === "duplicate" || name === "oversizedValue") assert.equal(snapshot.status, "partial");
    if (name === "oversizedValue") assert.equal(snapshot.rows[0].displayValue?.length, 8193);
    if (name === "unavailable") assert.equal(snapshot.capturedAt, undefined);
  });
}

test("multiple oversized values retain every named metric gap", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    name: `-large-${index}`,
    rawValue: "x".repeat(8193),
    dtype: 1,
    isDefault: false
  }));
  const snapshot = deriveDatabaseParameterSnapshot(
    {
      contractVersion: "openedge-db-parameter-capture.v1",
      databaseName: "parkbench",
      attemptedAt: "2026-09-28T10:00:00.000Z",
      capturedAt: "2026-09-28T10:00:00.000Z",
      source: "_DbParams",
      status: "complete",
      rows
    },
    identity
  );
  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.rows.length, rows.length);
  for (const row of rows)
    assert.ok(snapshot.gaps?.includes(`metric_value_limit:${row.name}`), row.name);
});

test("duplicate default VST rows do not make a complete snapshot partial", () => {
  const snapshot = deriveDatabaseParameterSnapshot(
    {
      contractVersion: "openedge-db-parameter-capture.v1",
      databaseName: "parkbench",
      attemptedAt: "2026-09-28T10:00:00.000Z",
      capturedAt: "2026-09-28T10:00:00.000Z",
      source: "_DbParams",
      status: "complete",
      rows: [
        { name: "-N", rawValue: "TCP", dtype: 1, isDefault: true },
        { name: "-N", rawValue: "TCP,UDP", dtype: 1, isDefault: true },
        { name: "-B", rawValue: "1000", dtype: 4, isDefault: false }
      ]
    },
    identity,
    startup
  );
  assert.equal(snapshot.status, "complete");
  assert.deepEqual(
    snapshot.rows.map((row) => row.name),
    ["-B"]
  );
  assert.equal(snapshot.verificationResults[0].verification, "matched");
});

test("a nondefault row wins over a duplicate default row for publication and verification", () => {
  const snapshot = deriveDatabaseParameterSnapshot(
    {
      contractVersion: "openedge-db-parameter-capture.v1",
      databaseName: "parkbench",
      attemptedAt: "2026-09-28T10:00:00.000Z",
      capturedAt: "2026-09-28T10:00:00.000Z",
      source: "_DbParams",
      status: "complete",
      rows: [
        { name: "-B", rawValue: "500", dtype: 4, isDefault: true },
        { name: "-B", rawValue: "1000", dtype: 4, isDefault: false }
      ]
    },
    identity,
    startup
  );
  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.rows[0].displayValue, "1000");
  assert.equal(snapshot.verificationResults[0].verification, "matched");
});

test("conflicting nondefault values remain an explicit partial gap", () => {
  const snapshot = deriveDatabaseParameterSnapshot(
    {
      contractVersion: "openedge-db-parameter-capture.v1",
      databaseName: "parkbench",
      attemptedAt: "2026-09-28T10:00:00.000Z",
      capturedAt: "2026-09-28T10:00:00.000Z",
      source: "_DbParams",
      status: "complete",
      rows: [
        { name: "-B", rawValue: "500", dtype: 4, isDefault: false },
        { name: "-B", rawValue: "1000", dtype: 4, isDefault: false }
      ]
    },
    identity,
    startup
  );
  assert.equal(snapshot.status, "partial");
  assert.deepEqual(snapshot.gaps, ["duplicate_parameter:-B"]);
  assert.equal(snapshot.verificationResults[0].verification, "unverifiable");
});
