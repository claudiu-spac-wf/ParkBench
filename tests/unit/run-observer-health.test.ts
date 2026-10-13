import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { observerDiagnosticsForRun } from "../../apps/control-plane/src/runs/coordinator";

describe("run observer health", () => {
  it("surfaces retained per-phase collection diagnostics for the selected observer", () => {
    const counts = [
      { observerId: "core", diagnostics: [{ code: "declared_metric_missing", phase: "measurement" }] },
      { observerId: "files", diagnostics: [{ code: "unrelated" }] },
      { observerId: "core", diagnostics: [{ code: "sample_failed", phase: "cooldown" }] }
    ];
    assert.deepEqual(observerDiagnosticsForRun(counts, "core"), [
      { code: "declared_metric_missing", phase: "measurement" },
      { code: "sample_failed", phase: "cooldown" }
    ]);
  });
});
