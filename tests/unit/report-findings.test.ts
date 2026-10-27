import test from "node:test";
import assert from "node:assert/strict";
import { nativeColumns } from "../../packages/contracts/src/database-analysis-definitions";
import { projectedRow } from "../../apps/control-plane/src/reports/native-parser";
import { findingsForRow } from "../../apps/control-plane/src/reports/findings";
test("all concern boundaries and size exemptions are exact", () => {
  for (const [records, factor, scatter, expected] of [
    ["1", "1.499", "1.5", "none"],
    ["1", "1.5", "2", "review"],
    ["1000", "2.000", "2", "higher_concern"],
    ["0", "9", "9", "not_assessed"]
  ]) {
    const columns = nativeColumns("table", ["Records", "Frag Factor", "Scatter Factor"]),
      row = projectedRow(columns, [records, factor, scatter], 1),
      f = findingsForRow("table", row, columns);
    assert.equal(f[0].severity, expected);
    if (records === "1") assert.equal(f[1].severity, "not_assessed");
  }
  for (const [blocks, util, severity] of [
    ["100", "24.999", "higher_concern"],
    ["100", "25", "review"],
    ["100", "50", "none"],
    ["99", "1", "not_assessed"],
    ["100", "?", "unavailable"]
  ]) {
    const columns = nativeColumns("index", ["Blocks", "Utilization"]);
    assert.equal(
      findingsForRow("index", projectedRow(columns, [blocks, util], 1), columns)[0].severity,
      severity
    );
  }
});
test("qualified names retain distinct tenant, partition, owner and zero identifiers", () => {
  const columns = nativeColumns("table", [
    "Area #",
    "Owner",
    "Table",
    "Table #",
    "Tenancy #",
    "Partition #",
    "Records",
    "Frag Factor"
  ]);
  const a = projectedRow(columns, ["0", "PUB", "Customer", "0", "0", "0", "1", "2"], 1),
    b = projectedRow(columns, ["0", "PUB", "Customer", "0", "1", "0", "1", "2"], 2);
  assert.notEqual(a.objectKey, b.objectKey);
  assert.ok(a.objectKey.includes('"0"'));
  assert.equal(a.label, b.label);
});
