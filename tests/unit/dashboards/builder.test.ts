import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UNIT_CONVENTIONS } from "../../../packages/dashboards/src/units";
import { ranking, totals, withOther } from "../../../packages/dashboards/src/topn";
import { legend } from "../../../packages/dashboards/src/naming";
import { tieBreakRules } from "../../../packages/dashboards/src/rules";
import { generatedDashboards, panelById } from "../../helpers/dashboards";

describe("unit conventions (data-model UnitConvention)", () => {
  it("maps every category to the required unit", () => {
    const expected: Record<string, string> = {
      cpu_pct: "percent",
      cpu_seconds: "s",
      memory: "bytes",
      disk_throughput: "Bps",
      disk_iops: "iops",
      net_throughput: "Bps",
      net_packets: "pps",
      table_rate: "short",
      table_total: "short",
      requests: "reqps",
      duration: "s"
    };
    for (const [category, unit] of Object.entries(expected))
      assert.equal(
        UNIT_CONVENTIONS[category as keyof typeof UNIT_CONVENTIONS].unit,
        unit,
        category
      );
    assert.equal(UNIT_CONVENTIONS.cpu_pct.max, undefined);
    assert.equal(UNIT_CONVENTIONS.table_rate.axisLabel, "records/s");
    assert.equal(UNIT_CONVENTIONS.table_total.axisLabel, "records");
  });
});

describe("legend naming", () => {
  it("prefixes the run and names the direction", () => {
    assert.equal(
      legend({ runPrefix: true, entity: "{{device}}", direction: "Read" }),
      "{{run_id}} · {{device}} · Read"
    );
    assert.equal(
      legend({ runPrefix: false, entity: "{{device}}", direction: "Out" }),
      "{{device}} · Out"
    );
  });
});

describe("top-N expressions (research R6)", () => {
  const score = (extra: string) =>
    `sum by (run_id, table) (increase(t{${['run_id=~"$run_id"', extra].filter(Boolean).join(",")}}[$__range] @ end()))`;
  const rank = ranking({
    key: "table",
    n: 5,
    score,
    excludeFromRanking: 'table!="other"',
    bias: "parkbench:table_tiebreak_bias"
  });

  it("ranks per run over the whole range with a tie-break bias", () => {
    assert.match(rank.top, /^topk by \(run_id\) \(5, /);
    assert.match(rank.top, /\[\$__range\] @ end\(\)/);
    assert.match(rank.top, /table!="other"/);
    assert.match(rank.top, /\+ on \(table\) group_left \(\) parkbench:table_tiebreak_bias\) or/);
  });

  it("builds Other from unranked entries and gates it on activity", () => {
    const expr = withOther(rank, "sum by (run_id, table) (rate(t[1m]))");
    assert.match(expr, /label_replace\(sum by \(run_id\) \(.* unless on \(run_id, table\)/);
    assert.match(expr, /"table", "Other", "", ""/);
    assert.match(expr, /and on \(run_id\) \(sum by \(run_id\) .* > 0\)\)$/);
  });

  it("shares one ranking between the rate and totals views", () => {
    const dashboards = generatedDashboards();
    const summary = dashboards["parkbench-run-summary"];
    for (const kind of ["reads", "writes"]) {
      const rate = panelById(summary, `rs.table_${kind}_rate`).targets[0].expr;
      const total = panelById(summary, `rs.table_${kind}_total`).targets[0].expr;
      assert.equal(
        rate.replace('view="rate"', 'view="total"'),
        total,
        `${kind}: both views share the fixed membership inputs`
      );
    }
    assert.match(totals(rank, score("")), /^sort_desc\(/);
  });

  it("combines creates, updates and deletes into one writes series per table", () => {
    const summary = generatedDashboards()["parkbench-run-summary"];
    const writes = panelById(summary, "rs.table_writes_rate").targets;
    assert.equal(writes.length, 1);
    assert.match(writes[0].expr, /operation="write"/);
    assert.match(writes[0].expr, /parkbench_table_rank/);
  });
});

describe("tie-break rules", () => {
  it("records no biased table-reference series", () => {
    assert.match(tieBreakRules(), /groups: \[\]/);
    assert.doesNotMatch(tieBreakRules(), /vector|table_tiebreak_bias|Customer/);
  });
});
