import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DashboardContext } from "../../packages/contracts/src";

describe("comparison and dashboard contract", () => {
  it("allows descriptive context without a baseline", () => {
    const context: DashboardContext = {
      id: "dashctx_descriptive",
      runIds: ["run_a", "run_b"],
      metricScope: ["latency"],
      dashboardRefs: [],
      variables: { run_id: ["run_a", "run_b"] },
      availability: "degraded",
      expiresAt: new Date(Date.now() + 1000).toISOString()
    };
    assert.equal(context.baselineRunId, undefined);
    assert.equal(context.availability, "degraded");
  });
});
