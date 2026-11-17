import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnosticCounterTotal,
  diagnosticCounterRate,
  sumDiagnosticTotals
} from "../../apps/control-plane/src/grafana/diagnostic-totals";
import { aggregateNamedLatchTotals } from "../../apps/control-plane/src/grafana/native-diagnostics";

test("observed totals never bridge explicit unavailability, missing acquisitions or requested edges", () => {
  const points: Array<[number, number | null]> = [
    [10, 100],
    [20, 107],
    [30, null],
    [40, 1000],
    [50, 1003],
    [80, 5000],
    [90, 5002]
  ];
  assert.deepEqual(diagnosticCounterTotal(points, 0, 100, 10), { value: 12, coverage: "partial" });
  assert.deepEqual(diagnosticCounterTotal(points, 15, 85, 10), { value: 3, coverage: "partial" });
  assert.deepEqual(
    diagnosticCounterTotal(
      [
        [10, 100],
        [30, 1000]
      ],
      0,
      40,
      10
    ),
    { value: null, coverage: "unavailable" }
  );
  assert.throws(
    () =>
      diagnosticCounterTotal(points, 0, 100, 10, false, () => {
        throw Error("deadline");
      }),
    /deadline/
  );
});
test("combining partial/unavailable source totals conserves supported values and true zeros", () => {
  assert.deepEqual(
    sumDiagnosticTotals([{ value: 4, coverage: "partial" }, { value: "NaN" }, { value: 0 }]),
    { value: 4, coverage: "partial" }
  );
  assert.deepEqual(sumDiagnosticTotals([{ value: "NaN" }]), {
    value: null,
    coverage: "unavailable"
  });
  assert.deepEqual(sumDiagnosticTotals([{ value: 0 }]), { value: 0, coverage: "complete" });
});
test("named latch reductions sum only already reduced instance/epoch values and propagate partial coverage", () => {
  const row = (epoch: string, id: string, value: string, coverage: string) => ({
    metric: {
      run_id: "run",
      latch_name: "buffer",
      latch_type: "shared",
      database_epoch: epoch,
      latch_id: id,
      coverage_status: coverage,
      coverage_note: coverage === "partial" ? " [partial]" : ""
    },
    value: [100, value]
  });
  const rows = [
    row("first", "1", "7", "complete"),
    row("second", "1", "3", "partial"),
    row("second", "2", "NaN", "unavailable")
  ];
  const original = structuredClone(rows),
    reduced = aggregateNamedLatchTotals(rows);
  assert.equal(reduced.length, 1);
  assert.equal(reduced[0].value[1], "10");
  assert.equal(reduced[0].metric.coverage_status, "partial");
  assert.equal((reduced[0].metric as Record<string, string>).database_epochs, '["first","second"]');
  assert.deepEqual(rows, original);
  assert.equal(
    aggregateNamedLatchTotals([row("first", "1", "NaN", "unavailable")])[0].value[1],
    "NaN"
  );
});

test("partial instant rates divide observed deltas by observed time without filling a gap", () => {
  assert.deepEqual(
    diagnosticCounterRate(
      [
        [0, 0],
        [10, 10],
        [20, 20],
        [40, 40],
        [50, 50]
      ],
      0,
      50,
      10
    ),
    { value: 1, coverage: "partial" }
  );
  assert.deepEqual(
    diagnosticCounterRate(
      [
        [0, 0],
        [20, 20]
      ],
      0,
      20,
      10
    ),
    { value: null, coverage: "unavailable" }
  );
});
