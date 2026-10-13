import test from "node:test";
import assert from "node:assert/strict";
import frozen from "../../fixtures/grafana-dashboards/coverage/legacy-v1.json";
import { generatedDashboards, panelsOf } from "../../helpers/dashboards";
import {
  DASHBOARD_CATALOG,
  validateDashboardCatalog
} from "../../../packages/dashboards/src/model";
import {
  isRetiredAvailabilityPanel,
  RETIRED_AVAILABILITY_PANELS
} from "../../../packages/dashboards/src/queries/diagnostic";
import { analyzeRunScope } from "../../../apps/control-plane/src/grafana/run-scope";
import { interpolate } from "../../helpers/dashboards";
const dashboards = generatedDashboards();
test("v3 catalog has ten unique dashboards in the 4/5/1 folder split and 89 retained reviewed meanings and four explicitly retired availability panels", () => {
  validateDashboardCatalog();
  assert.equal(Object.keys(dashboards).length, 10);
  assert.equal(frozen.mappings.length, 93);
  const panels = Object.values(dashboards)
    .flatMap(panelsOf)
    .map((p) => p.panel);
  assert.equal(RETIRED_AVAILABILITY_PANELS.length, 4);
  let retired = 0;
  for (const mapping of frozen.mappings) {
    const matches = panels.filter(
      (p) =>
        p.parkbench?.legacy?.uid === mapping.originalUid &&
        p.parkbench?.legacy?.panelId === mapping.panel.id
    );
    if (isRetiredAvailabilityPanel(mapping.originalUid, mapping.panel.id)) {
      assert.equal(matches.length, 0, `${mapping.originalUid}/${mapping.panel.title}`);
      retired++;
      continue;
    }
    assert.equal(matches.length, 1, `${mapping.originalUid}/${mapping.panel.title}`);
    const panel = matches[0];
    assert.ok(panel.parkbench.panelId);
    assert.ok(panel.description || panel.options?.content);
    if (mapping.originalUid === "parkbench-database-parameters") {
      if (mapping.panel.type !== "text")
        assert.match(panel.targets[0].expr, /parkbench_parameter_snapshot_/);
      continue;
    }
    for (const original of (mapping.panel as any).targets ?? []) {
      for (const name of new Set<string>(
        original.expr.match(/\b(?:parkbench_[a-z_]+|container_[a-z_]+|node_[a-z_]+)\b/g) ?? []
      ))
        assert.ok(
          panel.targets.some((t: any) => t.expr.includes(name) || (name.startsWith("parkbench_openedge_db_") && (t.expr.includes(`metric="${name.replace("parkbench_openedge_db_", "")}"`) || (name === "parkbench_openedge_db_buffer_pool_free_buffers" && t.expr.includes('metric="free_capacity"')) || (["parkbench_openedge_db_buffer_pool_logical_reads_total", "parkbench_openedge_db_buffer_pool_os_reads_total", "parkbench_openedge_db_buffer_pool_cumulative_cache_hit_ratio"].includes(name) && t.expr.includes('metric="cumulative_hit_ratio"'))))),
          `${panel.title}: missing ${name}`
        );
    }
    if (panel.type === "timeseries")
      assert.equal(panel.fieldConfig.defaults.custom.spanNulls, false);
    if (mapping.originalUid !== "parkbench-pas-instances" || mapping.panel.id !== 5)
      assert.equal(
        panel.fieldConfig?.defaults?.unit,
        mapping.panel.fieldConfig?.defaults?.unit === "s" &&
          /time per second/.test(mapping.panel.title)
          ? "suffix:s/s"
          : mapping.panel.fieldConfig?.defaults?.unit
      );
  }
  assert.equal(retired, 4);
  for (const entry of DASHBOARD_CATALOG) assert.equal(dashboards[entry.uid].title, entry.title);
});
test("all run-scoped v3 targets preserve explicit run scope, diagnostic gaps and operation-specific membership", () => {
  for (const entry of DASHBOARD_CATALOG.filter((e) => e.runSelection === "multi"))
    for (const { panel } of panelsOf(dashboards[entry.uid]))
      for (const target of panel.targets ?? []) {
        const expr = interpolate(target.expr, ["coverage_a", "coverage_b"], 120)
          .replaceAll("$phase", ".*")
          .replaceAll("$replica", "pas-[0-9]+")
          .replaceAll("$table", ".*")
          .replaceAll("$__from", "946684800000")
          .replaceAll("$__to", "946684920000");
        const scope = analyzeRunScope(expr);
        assert.notEqual(
          scope.kind,
          "error",
          `${entry.title}/${panel.title}: ${JSON.stringify(scope)}`
        );
        if (panel.parkbench?.topN?.key === "table") {
          assert.equal(panel.parkbench.topN.n, 10);
          assert.match(expr, /parkbench_table_rank/);
          assert.equal(panel.parkbench.topN.tieBreak, "value_then_name");
        }
        assert.ok(!expr.includes("table_tiebreak_bias"));
      }
});

test("generated dashboards omit all measurement availability charts and queries", () => {
  const allPanels = Object.values(dashboards)
    .flatMap(panelsOf)
    .map((p) => p.panel);
  assert.equal(allPanels.filter((p) => /availability/i.test(p.title)).length, 0);
  for (const panel of allPanels)
    for (const target of panel.targets ?? [])
      assert.doesNotMatch(target.expr, /parkbench_openedge_db_metric_available/);
});
