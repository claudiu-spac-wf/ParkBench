import assert from "node:assert/strict";
import test from "node:test";
import { grafanaDashboardUrl } from "../../apps/web/src/shared/grafana-dashboard-url";

test("Grafana dashboard URL carries multiple selected runs and absolute bounds", () => {
  const url = grafanaDashboardUrl({ grafanaUrl: "http://127.0.0.1:13001/",
    variables: { experiment_id: ["exp-a"], run_id: ["run-a", "run-b"], phase: ["idle", "measurement"] },
    timeRange: { from: "2026-09-28T08:00:00.000Z", to: "2026-09-28T09:00:00.000Z" }
  }, "parkbench-database-parameters");
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/d/parkbench-database-parameters");
  assert.deepEqual(parsed.searchParams.getAll("var-run_id"), ["run-a", "run-b"]);
  assert.deepEqual(parsed.searchParams.getAll("var-experiment_id"), ["exp-a"]);
  assert.deepEqual(parsed.searchParams.getAll("var-phase"), ["idle", "measurement"]);
  assert.equal(parsed.searchParams.get("from"), String(Date.parse("2026-09-28T08:00:00.000Z")));
  assert.equal(parsed.searchParams.get("to"), String(Date.parse("2026-09-28T09:00:00.000Z")));
});

test("Grafana dashboard URL keeps live end and requires an approved base and UID", () => {
  const url = grafanaDashboardUrl({ grafanaUrl: "http://localhost:13001",
    runIds: ["run-a"], timeRange: { from: "2026-09-28T08:00:00.000Z", to: "now" }
  }, "overview");
  assert.equal(new URL(url!).searchParams.get("to"), "now");
  assert.equal(grafanaDashboardUrl({ runIds: ["run-a"] }, "overview"), undefined);
  assert.equal(grafanaDashboardUrl({ grafanaUrl: "http://localhost:13001" }), undefined);
});
