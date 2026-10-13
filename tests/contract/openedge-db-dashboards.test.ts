import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generatedDashboards, panelsOf } from "../helpers/dashboards";
import { DASHBOARD_CATALOG } from "../../packages/dashboards/src/model";
const dashboards = generatedDashboards();
test("every generated diagnostic preserves named native counter rate semantics and source units", () => {
  for (const dashboard of Object.values(dashboards))
    for (const { panel } of panelsOf(dashboard))
      for (const target of panel.targets ?? [])
        if (/parkbench_openedge_db_[a-z_]+_total/.test(target.expr))
          assert.match(target.expr, /\b(rate|increase)\s*\(/, panel.title);
  const expressions = Object.values(dashboards)
    .flatMap(panelsOf)
    .flatMap((p) => p.panel.targets ?? [])
    .map((t) => t.expr)
    .join("\n");
  for (const metric of [
    "parkbench_openedge_db_index_operations_total",
    "parkbench_openedge_db_bi_bytes_written_total",
    "parkbench_openedge_db_apw_all_process_database_writes_total",
    "parkbench_openedge_db_lock_cancellations_total"
  ])
    assert.ok(
      expressions.includes(metric) ||
        expressions.includes(`metric="${metric.replace("parkbench_openedge_db_", "")}"`),
      metric
    );
  assert.match(
    expressions,
    /histogram_quantile\(0\.95, sum by \((?:run_id, le|le, run_id), operation\)/
  );
  assert.doesNotMatch(expressions, /table_tiebreak_bias|parkbench_host_cpu_utilization_ratio/);
});
test("PAS native replicas and owned container resource views preserve separate directions and uncapped one-core CPU", () => {
  const panels = panelsOf(dashboards["parkbench-pas-instances"]).map((p) => p.panel);
  const cpu = panels.find((p) => p.parkbench.legacy?.panelId === 5);
  assert.equal(cpu.fieldConfig.defaults.max, undefined);
  assert.match(cpu.targets[0].expr, /parkbench-run-owned-cadvisor/);
  assert.match(cpu.targets[0].expr, /cpu=~"total\|"/);
  for (const id of [7, 8]) {
    const p = panels.find((p) => p.parkbench.legacy?.panelId === id);
    assert.equal(p.targets.length, 2);
    assert.ok(p.targets.every((t: any) => !t.expr.includes(" + ")));
  }
  assert.ok(panels.some((p) => p.parkbench.panelId === "pas.abl_weighted_average"));
});
test("startup tables read retained snapshots independently of visible phase/range and guide users to context artifacts", () => {
  const dashboard = dashboards["parkbench-database-parameters"];
  assert.ok(!dashboard.templating.list.some((v: any) => v.name === "experiment_id"));
  const panels = panelsOf(dashboard).map((p) => p.panel);
  const table = panels.find((p) => p.parkbench.legacy?.panelId === 1);
  assert.equal(table.type, "table");
  assert.equal(table.targets[0].expr, 'parkbench_parameter_snapshot_info{run_id=~"$run_id"}');
  assert.match(JSON.stringify(table.fieldConfig.overrides), /dateTimeAsIso/);
  const guidance = panels.find(
    (p) => p.type === "text" && !p.parkbench.panelId.startsWith("notice.")
  );
  assert.match(guidance.options.content, /Empty.*default/);
  assert.match(guidance.options.content, /context.*parameter artifacts/);
  assert.doesNotMatch(guidance.options.content, /run-evidence/);
});
test("all ten managed diagnostics are generated at their catalog folder paths without legacy titles", () => {
  for (const entry of DASHBOARD_CATALOG) {
    const actual = JSON.parse(
      fs.readFileSync(`deploy/grafana/dashboards/${entry.folder}/${entry.file}`, "utf8")
    );
    assert.equal(actual.uid, entry.uid);
    assert.equal(actual.title, entry.title);
  }
});

test("summary has four genuine DB-wide index block charts and the requested rows/titles", () => {
  const summary = dashboards["parkbench-run-summary"];
  const tableRow = panelsOf(summary)
    .filter((p) => p.row === "DB tables and indexes")
    .map((p) => p.panel);
  for (const operation of ["reads", "writes"])
    for (const view of ["rate", "total"]) {
      const panel = tableRow.find((p) => p.parkbench.panelId === `rs.index_${operation}_${view}`);
      assert.ok(panel);
      assert.equal(
        panel.title,
        `DB index ${operation} (${view === "rate" ? "blocks/s" : "total"})`
      );
      assert.equal(
        panel.fieldConfig.defaults.unit,
        view === "rate" ? "suffix:blocks/s" : "suffix:blocks"
      );
      assert.match(
        panel.targets[0].expr,
        new RegExp(`metric="index_blocks_${operation === "reads" ? "read" : "written"}_total"`)
      );
      assert.match(panel.targets[0].expr, new RegExp(`view="${view}"`));
      assert.doesNotMatch(panel.targets[0].expr, /index=|index_operations/);
    }
  assert.ok(
    !summary.panels.some((p: any) => /Saved measurement results|Saved table activity/.test(p.title))
  );
  assert.ok(!panelsOf(summary).some((p) => p.panel.parkbench.panelId.startsWith("saved.")));
  assert.equal(
    dashboards["parkbench-database-recovery-concurrency"].title,
    "Database BI & APW data"
  );
  assert.equal(
    dashboards["parkbench-database-concurrency"].title,
    "Database transactions, locks, and latches"
  );
  assert.equal(Object.keys(dashboards).length, 10);
});

test("all managed and nested native targets retain readable explicit legends without epoch payloads", () => {
  let affected = 0;
  const visit = (panels: any[], dashboard: string) => {
    for (const panel of panels) {
      visit(panel.panels ?? [], dashboard);
      for (const target of panel.targets ?? []) {
        if (!/^(parkbench_db_diagnostic|parkbench_table_rank)\{/.test(target.expr)) continue;
        affected++;
        const context = `${dashboard}/${panel.title}`;
        assert.ok(target.legendFormat?.trim(), `${context}: no raw-label fallback`);
        assert.match(target.legendFormat, /\{\{run_id\}\}/, context);
        assert.doesNotMatch(target.legendFormat, /\{\{database_epoch\}\}| epoch /, context);
        assert.match(target.expr, /window_start="\$__from",window_end="\$__to"/, context);
        if (
          /^rs\.table_/.test(panel.parkbench.panelId) ||
          /^activity\.table_/.test(panel.parkbench.panelId)
        )
          assert.equal(
            target.legendFormat,
            target.expr.includes('aggregate="run"') ? "{{run_id}} Total" : "{{run_id}} {{table}}",
            context
          );
        if (/^rs\.index_/.test(panel.parkbench.panelId)) {
          assert.equal(
            target.legendFormat,
            target.expr.includes('aggregate="run"')
              ? "{{run_id}} Total"
              : "{{run_id}} {{database}}",
            context
          );
          assert.equal(
            panel.fieldConfig.defaults.unit,
            panel.parkbench.panelId.endsWith("_rate") ? "suffix:blocks/s" : "suffix:blocks",
            context
          );
        }
        if (panel.title === "Full table CRUD operation detail") {
          assert.equal(target.legendFormat, "{{run_id}} {{table}} {{operation}}", context);
          assert.equal(target.instant, true, context);
          assert.equal(target.format, "table", context);
        }
      }
    }
  };
  assert.equal(Object.keys(dashboards).length, 10);
  for (const dashboard of Object.values(dashboards)) visit(dashboard.panels, dashboard.title);
  assert.ok(affected > 90, `only ${affected} native/table targets covered`);
});

test("only the four Run Summary total panels add one labeled per-run total target", () => {
  const panels = panelsOf(dashboards["parkbench-run-summary"]).map((p) => p.panel);
  for (const entity of ["table", "index"])
    for (const operation of ["reads", "writes"]) {
      const total = panels.find((p) => p.parkbench.panelId === `rs.${entity}_${operation}_total`);
      const rate = panels.find((p) => p.parkbench.panelId === `rs.${entity}_${operation}_rate`);
      assert.equal(total.targets.length, 2);
      assert.equal(total.targets[1].legendFormat, "{{run_id}} Total");
      assert.equal(total.targets[1].instant, true);
      assert.equal(total.targets[1].expr, total.targets[0].expr.replace(/}$/, ',aggregate="run"}'));
      assert.equal(rate.targets.length, 1);
      assert.doesNotMatch(rate.targets[0].expr, /aggregate=/);
    }
  const totals = Object.values(dashboards)
    .flatMap(panelsOf)
    .flatMap((p) => p.panel.targets ?? [])
    .filter((t) => t.expr.includes('aggregate="run"'));
  assert.equal(totals.length, 4);
});

test("named latch panels separate native naps and optional seconds with readable identities and aggregate navigation", () => {
  const dashboard = dashboards["parkbench-database-concurrency"];
  assert.equal(dashboard.uid, "parkbench-database-concurrency");
  const panels = panelsOf(dashboard).map((p) => p.panel);
  const named = panels.filter((p) => p.parkbench.panelId.startsWith("latch.named."));
  assert.equal(named.length, 4);
  for (const panel of named) {
    assert.match(
      panel.targets[0].legendFormat,
      /\{\{run_id\}\}.*\{\{latch_name\}\}.*\{\{latch_type\}\}/
    );
    assert.doesNotMatch(panel.targets[0].legendFormat, /epoch/);
    assert.match(panel.targets[0].expr, /parkbench_db_diagnostic/);
    assert.match(
      panel.targets[0].expr,
      /phase="\$phase".*window_start="\$__from".*window_end="\$__to"/
    );
    assert.doesNotMatch(panel.targets[0].expr, /metric="latch_waits_total"/);
  }
  assert.equal(
    named.find((p) => p.parkbench.panelId.endsWith("wait_rate")).fieldConfig.defaults.unit,
    "suffix:naps/s"
  );
  assert.equal(
    named.find((p) => p.parkbench.panelId.endsWith("duration_total")).fieldConfig.defaults.unit,
    "s"
  );
  for (const panel of panels.filter((p) =>
    p.targets?.some((t: any) => /metric="latch_(?!named_)/.test(t.expr))
  )) {
    assert.match(panel.title, /aggregate/);
    assert.ok(
      panel.links.some(
        (l: any) =>
          l.title === "Named latch breakdown" &&
          l.url.includes("__url_time_range") &&
          l.url.includes("__all_variables")
      )
    );
  }
});
