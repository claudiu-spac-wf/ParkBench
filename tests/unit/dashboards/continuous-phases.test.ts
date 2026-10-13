import { it } from "node:test";
import assert from "node:assert/strict";
import { continuousPhaseQuery } from "../../../apps/control-plane/src/grafana/continuous-phases";

it("continuous dashboard phase filters use exact adjacent windows without hiding source data", () => {
  const timeline = {
    runId: "run",
    continuousMetrics: true,
    phases: [
      { phase: "warmup" as const, start: 1000, end: 3000 },
      { phase: "measurement" as const, start: 3000, end: 6000 },
      { phase: "cooldown" as const, start: 6000, end: 8000 }
    ]
  };
  const expression = 'sum(rate(node_cpu_seconds_total{run_id="run",phase="measurement"}[1m]))';
  const query = continuousPhaseQuery(expression, timeline);
  assert.match(query.expression, /phase=~/);
  assert.match(query.expression, /\^\$/);
  const raw = {
    data: {
      result: [
        {
          metric: { run_id: "run" },
          values: [
            [2, "10"],
            [3, "20"],
            [4, "30"],
            [6, "40"]
          ]
        }
      ]
    }
  };
  assert.deepEqual(query.filter(raw).data.result[0].values, [
    [3, "20"],
    [4, "30"]
  ]);
  const all = continuousPhaseQuery('node_cpu_seconds_total{run_id="run",phase=~".*"}', timeline);
  const gap = {
    data: {
      result: [
        {
          values: [
            [3, "20"],
            [5, "30"]
          ]
        }
      ]
    }
  };
  assert.equal(all.filter(gap), gap);
  assert.equal(gap.data.result[0].values.length, 2); // No fabricated point at second 4.
  const old = continuousPhaseQuery(expression, { ...timeline, continuousMetrics: false });
  assert.equal(old.expression, expression);
  const previous = { data: { result: [{ values: [[2, "10"]] }] } };
  assert.equal(old.filter(previous), previous);
});
