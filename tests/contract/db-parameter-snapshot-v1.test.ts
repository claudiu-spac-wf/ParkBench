import assert from "node:assert/strict";
import test from "node:test";
import { validateDatabaseParameterSnapshot } from "../../packages/contracts/src/database-parameter-snapshot";
import { parameterSnapshotSamples, formatParameterSnapshotMetrics } from
  "../../packages/observers/src/openedge-db/parameter-metrics";

const base = { contractVersion: "db-parameter-snapshot.v1" as const, runId: "run_1",
  experimentId: "exp_1", variantId: "variant_1", repetition: 1,
  databaseName: "parkbench", attemptedAt: "2026-09-28T10:00:00.000Z",
  capturedAt: "2026-09-28T10:00:00.000Z", status: "complete" as const,
  rowCount: 1, source: "_DbParams" as const, verificationResults: [],
  rows: [{ name: "-B", displayValue: "1000", valueStatus: "recorded" as const,
    numericValue: 1000, dtype: 4, isDefault: false as const }] };

test("plaintext snapshot validates and emits status, info, numeric, time, and row count", () => {
  const snapshot = validateDatabaseParameterSnapshot(base);
  const samples = parameterSnapshotSamples(snapshot, { runId: "run_1", experimentId: "exp_1",
    variantId: "variant_1", repetition: 1, phase: "idle" });
  assert.equal(samples.length, 5);
  assert.ok(samples.every((sample) => sample.labels.database_name === "parkbench" &&
    sample.labels.run_id === "run_1"));
  assert.match(formatParameterSnapshotMetrics(snapshot), /display_value="1000"/);
});

test("unavailable snapshot has no observation timestamp or invented rows", () => {
  const { capturedAt: _capturedAt, ...rest } = base;
  const snapshot = validateDatabaseParameterSnapshot({ ...rest, status: "unavailable",
    rowCount: 0, rows: [] });
  const samples = parameterSnapshotSamples(snapshot, { runId: "run_1", experimentId: "exp_1",
    variantId: "variant_1", repetition: 1, phase: "idle" });
  assert.equal(samples.some((sample) => sample.metricName.endsWith("timestamp_seconds")), false);
  assert.equal(samples.find((sample) => sample.metricName.endsWith("rows"))?.value, 0);
});
