import { DASHBOARD_CATALOG } from "../../../packages/dashboards/src/model";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generatedFiles, RETIRED_FILES, UNIT_CONVENTIONS } from "../../../packages/dashboards/src";
import { generatedDashboards, panelById, panelsOf, rowsOf } from "../../helpers/dashboards";

const LAYOUT = ["Summary", "CPU", "Memory", "Disk", "Network"];
const RUN_SCOPED = DASHBOARD_CATALOG.filter((e) => e.runSelection === "multi").map((e) => e.uid);
const SCOPED = [
  "parkbench-platform-resources",
  "parkbench-db-resources",
  "parkbench-run-resources"
];
const dashboards = generatedDashboards();
const layoutRows = (dashboard: any) => rowsOf(dashboard).filter((row) => LAYOUT.includes(row));

/**
 * Removes ranking sub-expressions: `topk by (run_id) (…)` and the "Other" activity gate
 * `and on (run_id) (…)`. They order and gate entries; they are not displayed values.
 */
function withoutRankings(expr: string): string {
  let output = expr;
  for (const marker of ["topk by (run_id) ", "and on (run_id) "]) {
    for (;;) {
      const start = output.indexOf(marker);
      if (start < 0) break;
      let i = start + marker.length;
      let depth = 0;
      for (; i < output.length; i++) {
        if (output[i] === "(") depth++;
        if (output[i] === ")" && --depth === 0) break;
      }
      output = `${output.slice(0, start)}RANKING${output.slice(i + 1)}`;
    }
  }
  return output;
}

describe("grafana-dashboards-v2: provisioning", () => {
  it("provisions exactly ten v3 dashboards with stable UIDs and catalog titles", () => {
    assert.deepEqual(
      Object.fromEntries(Object.values(dashboards).map((d: any) => [d.uid, d.title])),
      Object.fromEntries(DASHBOARD_CATALOG.map((e) => [e.uid, e.title]))
    );
  });

  it("keeps committed files identical to the builder output", () => {
    for (const [file, content] of Object.entries(generatedFiles()))
      assert.equal(
        fs.readFileSync(path.resolve(file), "utf8"),
        content,
        `${file} is out of date; run npm run dashboards:build`
      );
  });

  it("retires only the named legacy roots after preserved coverage verification", () => {
    for (const file of RETIRED_FILES) assert.equal(fs.existsSync(path.resolve(file)), false, file);
    for (const entry of DASHBOARD_CATALOG)
      assert.ok(fs.existsSync(path.join("deploy/grafana/dashboards", entry.folder, entry.file)));
  });

  it("provisions the ParkBench Runs datasource next to Prometheus", () => {
    const text = fs.readFileSync(
      path.resolve("deploy/grafana/provisioning/datasources/prometheus.yml"),
      "utf8"
    );
    assert.match(text, /uid: prometheus\n/);
    assert.match(text, /uid: parkbench-runs\n/);
    assert.match(text, /url: http:\/\/control-plane:3000\/api\/v1\/grafana\/prom/);
  });

  it("loads the generated rules and enables per-CPU cAdvisor metrics", () => {
    assert.match(
      fs.readFileSync(path.resolve("deploy/prometheus/prometheus.yml"), "utf8"),
      /rule_files:\n  - \/etc\/prometheus\/rules\/\*\.yml/
    );
    const compose = fs.readFileSync(path.resolve("deploy/platform-compose.yml"), "utf8");
    assert.match(compose, /\.\/prometheus\/rules:\/etc\/prometheus\/rules:ro/);
    const disabled = /--disable_metrics=([a-z_,]+)/.exec(compose)?.[1].split(",") ?? [];
    assert.ok(disabled.length > 0);
    assert.ok(!disabled.includes("percpu"));
    assert.ok(!disabled.includes("diskIO"));
  });
});

describe("grafana-dashboards-v2: units and directions (FR-001 to FR-007)", () => {
  it("takes every panel's unit from its category and splits directions", () => {
    for (const dashboard of Object.values(dashboards)) {
      for (const { panel } of panelsOf(dashboard)) {
        const meta = panel.parkbench;
        if (
          !meta ||
          meta.legacy ||
          meta.panelId.startsWith("rs.index_") ||
          !["timeseries", "bargauge"].includes(panel.type)
        )
          continue;
        const where = `${dashboard.title}/${panel.title}`;
        assert.equal(
          panel.fieldConfig.defaults.unit,
          meta.panelId.startsWith("latch.named.")
            ? (
                {
                  "latch.named.wait_rate": "suffix:naps/s",
                  "latch.named.wait_total": "suffix:naps",
                  "latch.named.duration_rate": "suffix:s/s",
                  "latch.named.duration_total": "s"
                } as Record<string, string>
              )[meta.panelId]
            : UNIT_CONVENTIONS[meta.category as keyof typeof UNIT_CONVENTIONS].unit,
          where
        );
        if (meta.category === "cpu_pct")
          assert.equal(panel.fieldConfig.defaults.max, undefined, where);
        if (panel.fieldConfig.defaults.unit === "s" && /cpu/i.test(panel.title))
          assert.equal(
            meta.panelId,
            "cpu.seconds_by_container",
            `${where}: CPU must be a percentage`
          );
        if (["disk_throughput", "disk_iops"].includes(meta.category)) {
          assert.equal(meta.split, "read_write", where);
          assert.deepEqual(
            panel.targets.map((t: any) => t.legendFormat.split(" · ").at(-1)),
            ["Read", "Write"],
            where
          );
        }
        if (["net_throughput", "net_packets"].includes(meta.category)) {
          assert.equal(meta.split, "in_out", where);
          assert.deepEqual(
            panel.targets.map((t: any) => t.legendFormat.split(" · ").at(-1)),
            ["In", "Out"],
            where
          );
        }
        for (const target of panel.targets ?? []) {
          const shown = withoutRankings(target.expr);
          const both = (a: RegExp, b: RegExp) => a.test(shown) && b.test(shown);
          assert.ok(
            !both(
              /reads(_bytes)?_total|disk_read/,
              /writes(_bytes)?_total|disk_written|disk_writes/
            ),
            `${where}: read+write combined`
          );
          assert.ok(!both(/receive_/, /transmit_/), `${where}: in+out combined`);
          if (target.expr.startsWith("parkbench_db_diagnostic")) {
            assert.match(target.expr, /view="(?:rate|total|gauge|cumulative)"/);
            continue;
          }
          for (const counter of target.expr.match(/\b[a-z_:]+_total\b/g) ?? [])
            assert.match(
              target.expr,
              /\b(rate|increase)\s*\(/,
              `${where}: ${counter} must use rate/increase`
            );
        }
        if (panel.type === "timeseries")
          // Connect null values across gaps of up to 1 minute (operator request, feature 014).
          assert.equal(panel.fieldConfig.defaults.custom.spanNulls, false, where);
      }
    }
  });
});

describe("grafana-dashboards-v2: Host Resources (FR-008 to FR-013)", () => {
  const host = dashboards["parkbench-host-resources"];
  it("has the required rows and panels", () => {
    assert.deepEqual(layoutRows(host), LAYOUT);
    const summaryRow = host.panels.find((p: any) => p.type === "row" && p.title === "Summary");
    assert.equal(summaryRow.collapsed, false);
    const summary = panelsOf(host)
      .filter((e) => e.row === "Summary")
      .map((e) => e.panel.parkbench.panelId);
    assert.deepEqual(summary, ["summary.cpu", "summary.memory", "summary.disk", "summary.network"]);
    for (const id of [
      "cpu.per_core",
      "memory.composition",
      "disk.throughput_by_disk",
      "disk.iops_by_disk",
      "network.throughput",
      "network.packets"
    ])
      assert.ok(panelById(host, id), id);
    assert.ok(!panelsOf(host).some((e) => /by_container/.test(e.panel.parkbench?.panelId ?? "")));
    assert.deepEqual(
      panelById(host, "memory.composition").targets.map((t: any) => t.legendFormat),
      ["Used", "Cached/buffers", "Available", "Swap used"]
    );
  });

  it("uses the ambient node-exporter job and physical device filters", () => {
    for (const { panel } of panelsOf(host))
      for (const target of panel.targets ?? []) {
        if (target.expr.startsWith("parkbench_run_")) continue;
        assert.match(target.expr, /job="node-exporter"/, panel.title);
      }
    assert.match(
      panelById(host, "summary.network").targets[0].expr,
      /device!~"\$interface_exclude"/
    );
    assert.match(panelById(host, "summary.disk").targets[0].expr, /device!~"\$disk_exclude"/);
    assert.equal(panelById(host, "summary.cpu").targets.length, 1);
  });

  it("offers a run picker that changes only the time range", () => {
    const picker = panelById(host, "picker.runs");
    assert.equal(picker.datasource.uid, "parkbench-runs");
    assert.equal(
      picker.targets[0].expr,
      'parkbench_run_window{window_start="$__from",window_end="$__to"}'
    );
    assert.match(
      JSON.stringify(picker),
      /var-picker_run=\$\{__data\.fields\.run_id\}&from=\$\{__data\.fields\.start_ms\}&to=\$\{__data\.fields\.end_ms\}/
    );
    assert.ok(host.templating.list.some((v: any) => v.name === "picker_run"));
    assert.ok(!host.templating.list.some((v: any) => v.name === "run_id"));
  });
});

describe("grafana-dashboards-v2: scoped dashboards (FR-014, FR-015, FR-015a)", () => {
  it("matches the host layout and adds by-container panels", () => {
    for (const uid of SCOPED) {
      const dashboard = dashboards[uid];
      assert.deepEqual(layoutRows(dashboard), LAYOUT, uid);
      for (const id of [
        "summary.cpu",
        "summary.memory",
        "summary.disk",
        "summary.network",
        "cpu.seconds_by_container",
        "memory.by_container",
        "disk.throughput_by_disk",
        "disk.iops_by_disk",
        "disk.throughput_by_container",
        "network.throughput",
        "network.packets"
      ])
        assert.ok(panelById(dashboard, id), `${uid}: ${id}`);
      const memory = panelById(dashboard, "memory.by_container");
      assert.match(memory.targets[0].expr, /container_memory_working_set_bytes/);
      assert.match(memory.targets[1].expr, /container_memory_cache/);
      assert.match(memory.targets[2].expr, /container_memory_swap/);
      assert.match(memory.targets[3].expr, /container_spec_memory_limit_bytes\{[^}]*\} > 0/);
      assert.ok(!JSON.stringify(memory).includes("Available"));
      assert.match(
        panelById(dashboard, "cpu.seconds_by_container").targets[0].expr,
        /topk by \(run_id\) \(10, /
      );
    }
  });

  it("filters each scope and never counts run-tagged duplicate scrapes", () => {
    const every = (uid: string) =>
      panelsOf(dashboards[uid])
        .flatMap((e) => e.panel.targets ?? [])
        .filter((t: any) => !t.expr.startsWith("parkbench_run_"));
    for (const target of every("parkbench-platform-resources")) {
      assert.match(
        target.expr,
        /job="cadvisor",container_label_com_docker_compose_project="parkbench-platform"/
      );
      assert.doesNotMatch(target.expr, /run_id=~/);
    }
    for (const target of every("parkbench-db-resources"))
      assert.match(
        target.expr,
        /job="parkbench-run-owned-cadvisor",run_id=~"\$run_id",service="database"/
      );
    for (const target of every("parkbench-run-resources"))
      assert.match(
        target.expr,
        /job="parkbench-run-owned-cadvisor",run_id=~"\$run_id",service!="database"/
      );
  });
});

describe("grafana-dashboards-v2: Run Summary (FR-017 to FR-021)", () => {
  const summary = dashboards["parkbench-run-summary"];
  it("contains the ten required items in order", () => {
    const ids = panelsOf(summary)
      .map((e) => e.panel.parkbench?.panelId)
      .filter((id: string) => id?.startsWith("rs."));
    assert.deepEqual(ids, [
      "rs.db_cpu",
      "rs.db_memory",
      "rs.pas_cpu",
      "rs.pas_memory",
      "rs.db_disk",
      "rs.db_disk_iops",
      "rs.table_reads_rate",
      "rs.table_reads_total",
      "rs.table_writes_rate",
      "rs.table_writes_total",
      "rs.index_reads_rate",
      "rs.index_reads_total",
      "rs.index_writes_rate",
      "rs.index_writes_total",
      "rs.pas_requests",
      "rs.pas_failures",
      "rs.abl_time"
    ]);
    for (const id of ["rs.db_disk", "rs.db_disk_iops"])
      assert.equal(panelById(summary, id).gridPos.w, 24, id);
    assert.match(
      panelById(summary, "rs.pas_requests").targets[0].expr,
      /sum by \(run_id, replica\)/
    );
    assert.match(panelById(summary, "rs.pas_cpu").targets[0].expr, /sum by \(run_id, service\)/);
    assert.match(
      panelById(summary, "rs.abl_time").description,
      /p95 unavailable: the PAS metric has no distribution/
    );
  });
});

describe("grafana-dashboards-v2: run selection, notices and links (FR-016, FR-024a)", () => {
  it("scopes every run-scoped query through the ParkBench Runs datasource", () => {
    for (const uid of RUN_SCOPED) {
      const dashboard = dashboards[uid];
      const run = dashboard.templating.list.find((v: any) => v.name === "run_id");
      assert.equal(run.definition, "label_values(parkbench_run_window, run_id)", uid);
      assert.equal(run.multi, true);
      assert.equal(run.includeAll, false);
      for (const { panel } of panelsOf(dashboard)) {
        assert.equal(panel.datasource.uid, "parkbench-runs", `${uid}/${panel.title}`);
        for (const target of panel.targets ?? [])
          assert.match(target.expr, /run_id=~"\$run_id"/, `${uid}/${panel.title}`);
      }
      const ids = panelsOf(dashboard).map((e) => e.panel.parkbench?.panelId);
      assert.ok(ids.includes("notice.mode_mismatch") && ids.includes("notice.excluded_runs"), uid);
      assert.ok(
        dashboard.annotations.list.some(
          (a: any) => a.expr === 'parkbench_run_phase_boundary{run_id=~"$run_id"}'
        )
      );
    }
  });

  it("links every dashboard to the other four through the redirect endpoint", () => {
    for (const dashboard of Object.values(dashboards)) {
      const targets = dashboard.links.filter(
        (l: any) => /dashboard=parkbench-/.test(l.url) && !/reset=1/.test(l.url)
      );
      assert.equal(targets.length, 9, dashboard.title);
      for (const link of dashboard.links) {
        assert.match(link.url, /^\$\{parkbench_web_url\}\/api\/v1\/grafana\/open\?dashboard=/);
        assert.equal(link.includeVars, true);
      }
      assert.ok(targets.every((l: any) => l.keepTime === true));
      const reset = dashboard.links.some((l: any) => /reset=1/.test(l.url));
      assert.equal(reset, RUN_SCOPED.includes(dashboard.uid), dashboard.title);
    }
  });
});

it("keeps chart legends to the right, uses text notices and routes the picker to stored full-window metadata", () => {
  for (const dashboard of Object.values(generatedDashboards()))
    for (const { panel } of panelsOf(dashboard)) {
      if (panel.type === "timeseries")
        assert.deepEqual(panel.options.legend, {
          displayMode: "table",
          placement: "right",
          calcs: ["mean", "max"],
          sortBy: "Mean",
          sortDesc: true
        });
      if (panel.parkbench?.panelId.startsWith("notice.")) {
        assert.equal(panel.type, "text");
        assert.equal(panel.targets, undefined);
        assert.match(panel.options.content, /\$\{notice_/);
      }
      if (panel.parkbench?.panelId === "picker.runs") {
        assert.equal(panel.targets[0].datasource.uid, "parkbench-runs");
        assert.match(panel.targets[0].expr, /window_start="\$__from",window_end="\$__to"/);
      }
      if (panel.parkbench?.panelId === "cpu.per_core")
        assert.equal(dashboard.uid, "parkbench-host-resources");
    }
});
