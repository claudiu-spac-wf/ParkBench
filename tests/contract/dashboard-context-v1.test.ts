import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DashboardContext } from "../../packages/contracts/src";

describe("dashboard-context.v1", () => {
  it("keeps dashboard context non-secret and scoped to run IDs", () => {
    const context: DashboardContext = {
      id: "dashctx_test",
      runIds: ["run_test"],
      metricScope: ["workload"],
      dashboardRefs: [],
      variables: { run_id: ["run_test"] },
      availability: "available",
      expiresAt: new Date(Date.now() + 1000).toISOString()
    };
    assert.deepEqual(context.variables.run_id, ["run_test"]);
    assert.equal(Object.prototype.hasOwnProperty.call(context, "password"), false);
  });
});
