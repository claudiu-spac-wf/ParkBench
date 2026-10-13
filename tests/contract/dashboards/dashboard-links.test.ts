import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { grafanaDashboardUrl } from "../../../apps/web/src/shared/grafana-dashboard-url";

describe("web UI dashboard links (FR-016a, FR-024)", () => {
  const context = {
    grafanaUrl: "http://127.0.0.1:13001",
    variables: { run_id: ["run_a", "run_b"] },
    timeRange: { from: "2026-09-29T10:00:00.000Z", to: "2026-09-29T11:00:00.000Z" },
    alignedTimeRange: { from: 946684790000, to: 946684850000 }
  };

  it("uses the aligned range for run-scoped v2 dashboards when several runs are selected", () => {
    const url = new URL(grafanaDashboardUrl(context, "parkbench-run-summary")!);
    assert.deepEqual(url.searchParams.getAll("var-run_id"), ["run_a", "run_b"]);
    assert.equal(url.searchParams.get("from"), "946684790000");
  });

  it("keeps clock time for other dashboards and for one run", () => {
    assert.equal(
      new URL(grafanaDashboardUrl(context, "parkbench-host-resources")!).searchParams.get("from"),
      String(Date.parse(context.timeRange.from))
    );
    const one = { ...context, variables: { run_id: ["run_a"] } };
    assert.equal(
      new URL(grafanaDashboardUrl(one, "parkbench-run-summary")!).searchParams.get("from"),
      String(Date.parse(context.timeRange.from))
    );
  });
});
