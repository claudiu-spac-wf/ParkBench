import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyReadinessProbeStatus } from "../../packages/compose-runner/src/orchestrator";
import { classifyRunError } from "../../apps/control-plane/src/runs/run-error";

describe("run readiness classification", () => {
  it("fails permanent client/container responses and retries transient or unavailable probes", () => {
    assert.equal(classifyReadinessProbeStatus(200), "ready");
    assert.equal(classifyReadinessProbeStatus(204), "ready");
    assert.equal(classifyReadinessProbeStatus(404), "failed");
    assert.equal(classifyReadinessProbeStatus(422), "failed");
    assert.equal(classifyReadinessProbeStatus(503), "retry");
    assert.equal(classifyReadinessProbeStatus(0), "retry");
  });

  it("maps runtime readiness failures and timeouts to the closed infrastructure codes", () => {
    const cases = [
      ["pas_readiness_failed:/health", "pas_readiness_failed"],
      ["database_readiness_failed:/health", "database_readiness_failed"],
      ["run_readiness_timeout:pas-2:/health", "pas_readiness_timeout"],
      ["run_readiness_timeout:database:/health", "database_readiness_timeout"]
    ] as const;
    for (const [message, code] of cases) {
      const classified = classifyRunError(new Error(message));
      assert.equal(classified?.failureKind, "infrastructure");
      assert.equal(classified?.failureCode, code);
      assert.ok((classified?.failureReason.length ?? 513) <= 512);
    }
  });
});
