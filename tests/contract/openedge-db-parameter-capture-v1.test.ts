import assert from "node:assert/strict";
import test from "node:test";
import { validateOpenEdgeDbParameterCapture } from "../../packages/contracts/src/openedge-db-parameter-capture";
import { validateBenchmarkImageManifest } from "../../packages/contracts/src/openedge-validation";
import { syntheticImageManifest } from "../helpers/openedge";

const base = { contractVersion: "openedge-db-parameter-capture.v1", databaseName: "parkbench",
  attemptedAt: "2026-09-28T10:00:00.000Z", source: "_DbParams", rows: [] };

test("image manifest declares native capture version", () => {
  const manifest = syntheticImageManifest("final");
  validateBenchmarkImageManifest(manifest, true);
  manifest.observerContract.parameterCaptureVersion = "wrong";
  assert.throws(() => validateBenchmarkImageManifest(manifest, true),
    /openedge_manifest_observer_contract_invalid/);
});

test("native complete, partial, unavailable timestamp invariants", () => {
  validateOpenEdgeDbParameterCapture({ ...base, status: "complete", capturedAt: base.attemptedAt });
  assert.throws(() => validateOpenEdgeDbParameterCapture({ ...base, status: "complete" }),
    /capture_invalid/);
  validateOpenEdgeDbParameterCapture({ ...base, status: "partial", reason: "read_failed" });
  validateOpenEdgeDbParameterCapture({ ...base, status: "unavailable", reason: "not_ready" });
  assert.throws(() => validateOpenEdgeDbParameterCapture({ ...base, status: "unavailable",
    reason: "not_ready", capturedAt: base.attemptedAt }), /capture_invalid/);
});

test("native bounds reject excessive row count and value length", () => {
  const row = { name: "-B", rawValue: "1", dtype: 4, isDefault: false };
  assert.throws(() => validateOpenEdgeDbParameterCapture({ ...base, status: "complete",
    capturedAt: base.attemptedAt, rows: Array(1025).fill(row) }), /capture_invalid/);
  assert.throws(() => validateOpenEdgeDbParameterCapture({ ...base, status: "partial",
    reason: "value_limit", capturedAt: base.attemptedAt,
    rows: [{ ...row, rawValue: "x".repeat(65537) }] }), /capture_invalid/);
});

test("native capture retains repeated VST names for nondefault selection", () => {
  const rows = [
    { name: "-N", rawValue: "TCP", dtype: 1, isDefault: true },
    { name: "-N", rawValue: "TCP,UDP", dtype: 1, isDefault: true }
  ];
  assert.equal(validateOpenEdgeDbParameterCapture({ ...base, status: "complete",
    capturedAt: base.attemptedAt, rows }).rows.length, 2);
});
