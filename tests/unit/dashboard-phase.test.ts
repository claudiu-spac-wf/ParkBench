import test from "node:test";
import assert from "node:assert/strict";
import { createDashboardContext } from "../../apps/control-plane/src/comparisons/dashboard-context-service";
import { ControlUiService } from "../../apps/control-plane/src/control-ui/service";
import { grafanaDashboardUrl } from "../../apps/web/src/shared/grafana-dashboard-url";

test("new contexts use metric phase labels instead of lifecycle names", () => {
  const context = createDashboardContext({id:"phase-test",runIds:["run"],phase:"warming_up|measuring|cooldown",expiresAt:"2030-01-01T00:00:00Z"});
  assert.deepEqual(context.variables.phase,["warmup|measurement|cooldown"]);
  assert.equal(context.phase,"warmup|measurement|cooldown");
});
test("existing run-page contexts generate working Grafana phase links without rewriting stored records", () => {
  const stored = {...createDashboardContext({id:"legacy",runIds:["run"],expiresAt:"2030-01-01T00:00:00Z"}),phase:"measuring",variables:{run_id:["run"],phase:["measuring"]}};
  const original=structuredClone(stored);
  const context=ControlUiService.prototype.getDashboard.call({runtime:{controlRepository:{getDashboard:()=>stored}}} as any,"legacy")!;
  const url=grafanaDashboardUrl({...context,grafanaUrl:"http://127.0.0.1:13001"},"parkbench-database-concurrency")!;
  assert.equal(new URL(url).searchParams.get("var-phase"),"measurement");
  assert.equal(context.phase,"measurement");assert.deepEqual(stored,original);
});
