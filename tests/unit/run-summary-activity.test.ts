import test from "node:test";
import assert from "node:assert/strict";
import { orderRankedSeries } from "../../apps/control-plane/src/grafana/table-ranking";
const row = (table: string, values: string[]) => ({
  metric: { table },
  values: values.map((v, i) => [i, v])
});
test("display order uses the selected-window mean, stable names for ties, and missing values last", () => {
  const rows = [
    row("Z", ["4", "8"]),
    row("Missing", ["NaN"]),
    row("A", ["6", "6"]),
    row("Other", ["10", "10"]),
    row("Low", ["0", "2"])
  ];
  const original = JSON.stringify(rows);
  assert.deepEqual(
    orderRankedSeries(rows, "rate").map((s) => s.metric.table),
    ["Other", "A", "Z", "Low", "Missing"]
  );
  assert.equal(JSON.stringify(rows), original);
});
test("total display order uses displayed totals including Other rather than rank membership order", () => {
  const rows = [
    { metric: { table: "B" }, value: [10, "100"] },
    { metric: { table: "Other" }, value: [10, "300"] },
    { metric: { table: "A" }, value: [10, "100"] },
    { metric: { table: "Missing" }, value: [10, "NaN"] }
  ];
  assert.deepEqual(
    orderRankedSeries(rows, "total").map((s) => s.metric.table),
    ["Other", "A", "B", "Missing"]
  );
});
