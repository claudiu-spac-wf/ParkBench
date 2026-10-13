import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  literalRunIds,
  scanSelectors
} from "../../../apps/control-plane/src/grafana/promql-selectors";
import { analyzeRunScope, narrowToRun } from "../../../apps/control-plane/src/grafana/run-scope";
import { generatedDashboards, panelsOf } from "../../helpers/dashboards";

describe("PromQL selector scanner", () => {
  it("finds selectors and skips functions, keywords, label lists, strings and ranges", () => {
    const expr =
      'topk by (run_id) (5, sum by (run_id, table) (increase(foo_total{run_id=~"(a|b)",op="x"}[5m] @ end()))) and on (run_id) label_replace(bar{run_id="a"}, "table", "Other", "", "") offset 5m';
    const selectors = scanSelectors(expr);
    assert.deepEqual(
      selectors.map((s) => s.metric),
      ["foo_total", "bar"]
    );
    assert.deepEqual(
      selectors[0].matchers.map((m) => [m.name, m.op, m.value]),
      [
        ["run_id", "=~", "(a|b)"],
        ["op", "=", "x"]
      ]
    );
  });

  it("treats bare metric names and brace-only selectors as selectors", () => {
    assert.deepEqual(
      scanSelectors("up").map((s) => s.metric),
      ["up"]
    );
    assert.deepEqual(
      scanSelectors('{__name__="up",run_id="a"}').map((s) => s.metric),
      ["up"]
    );
    assert.deepEqual(scanSelectors("1 + 1").length, 0);
    assert.deepEqual(scanSelectors("vector(1)").length, 0);
  });

  it("accepts literal run IDs only", () => {
    assert.deepEqual(literalRunIds({ op: "=", value: "run_a" }), ["run_a"]);
    assert.deepEqual(literalRunIds({ op: "=~", value: "(buffer-sweep-ae4f|run\\.b)" }), [
      "buffer-sweep-ae4f",
      "run.b"
    ]);
    assert.equal(literalRunIds({ op: "=~", value: ".+" }), undefined);
    assert.equal(literalRunIds({ op: "!=", value: "a" }), undefined);
  });
});

describe("run-scope rule (grafana-runs-datasource.v1 R1, R7)", () => {
  it("rejects bypass attempts", () => {
    const cases: Array<[string, string]> = [
      ['up or foo{run_id="a"}', "run_matcher_required"],
      ['foo{run_id="a"} + on() group_left bar', "run_matcher_required"],
      ['foo{run_id=~".+"}', "run_matcher_required"],
      ['foo{run_id="a"} + foo{run_id="b"}', "run_matcher_mismatch"],
      ["up", "run_matcher_required"]
    ];
    for (const [expr, errorClass] of cases) {
      const scope = analyzeRunScope(expr);
      assert.equal(scope.kind, "error", expr);
      assert.equal((scope as any).errorClass, errorClass, expr);
    }
  });

  it("accepts constant-only expressions and reference selectors", () => {
    assert.equal(analyzeRunScope("1+1").kind, "constant");
    const scope = analyzeRunScope(
      'sum(foo{run_id="a"}) / scalar(count(node_cpu_seconds_total{job="node-exporter",mode="idle"})) + on (table) group_left () parkbench:table_tiebreak_bias'
    );
    assert.equal(scope.kind, "scoped");
    assert.deepEqual((scope as any).runIds, ["a"]);
  });

  it("classifies synthetic selectors", () => {
    const scope = analyzeRunScope('parkbench_run_phase_boundary{run_id=~"a|b"}');
    assert.equal(scope.kind, "synthetic");
    assert.deepEqual((scope as any).runIds, ["a", "b"]);
    assert.deepEqual(
      (analyzeRunScope('parkbench_run_phase_boundary{run_id=""}') as any).runIds,
      []
    );
    assert.equal(analyzeRunScope("parkbench_run_window").kind, "synthetic");
    assert.equal(analyzeRunScope('parkbench_run_window + foo{run_id="a"}').kind, "error");
  });

  it("narrows every run matcher to one run", () => {
    const expr = 'a{run_id=~"(x|y)"} + b{run_id=~"(x|y)"}';
    const scope = analyzeRunScope(expr) as any;
    assert.equal(narrowToRun(expr, scope.runMatchers, "x"), 'a{run_id="x"} + b{run_id="x"}');
  });

  it("accepts every query on the generated run-scoped dashboards", () => {
    const dashboards = generatedDashboards();
    for (const uid of [
      "parkbench-db-resources",
      "parkbench-run-resources",
      "parkbench-run-summary"
    ]) {
      for (const { panel } of panelsOf(dashboards[uid]))
        for (const target of panel.targets ?? []) {
          const expr = target.expr.replaceAll("$run_id", "(run_a|run_b)");
          const scope = analyzeRunScope(expr);
          assert.ok(
            scope.kind === "scoped" || scope.kind === "synthetic",
            `${uid}/${panel.title}: ${JSON.stringify(scope)}`
          );
        }
    }
  });
});
