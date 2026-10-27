import test from "node:test";
import assert from "node:assert/strict";
import { projectedRow } from "../../apps/control-plane/src/reports/native-parser";
import { nativeColumns } from "../../packages/contracts/src/database-analysis-definitions";
import { findingsForRow } from "../../apps/control-plane/src/reports/findings";

test("fixed-width native index decimals are valid and retain their exact source text", () => {
  const columns = nativeColumns("index", ["Table", "Blocks", "Size", "Utilization", "Factor"]);
  const values = ["Customer", " 100 ", " 9007199254740993", "   24.500", "   1.0"];
  const row = projectedRow(columns, values, 1);
  assert.deepEqual(
    row.cells.map((c) => c.sourceText),
    values
  );
  assert.deepEqual(
    row.cells.slice(1).map((c) => c.exact),
    ["100", "9007199254740993", "24.5", "1"]
  );
  assert.ok(row.cells.every((c) => c.availability === "AVAILABLE"));
  assert.equal(findingsForRow("index", row, columns)[0].severity, "higher_concern");
});
test("numeric padding normalization keeps missing and genuinely invalid numbers distinct", () => {
  const columns = nativeColumns("index", ["Utilization"]);
  for (const missing of ["", "  ", " ? ", "\t?\t"]) {
    const cell = projectedRow(columns, [missing], 1).cells[0];
    assert.equal(cell.availability, "MISSING");
    assert.equal(cell.exact, null);
  }
  for (const invalid of [" -1 ", "1e2", "24.5%", "1 000", "NaN", "Infinity"]) {
    const cell = projectedRow(columns, [invalid], 1).cells[0];
    assert.equal(cell.availability, "INVALID");
    assert.equal(cell.exact, null);
  }
  assert.equal(projectedRow(columns, ["   0.0"], 1).cells[0].exact, "0");
});
test("LOB byte ranges are native decimals while table ranges and counts stay integers", () => {
  const columns = nativeColumns("lob", ["LOBs", "Size", "Min", "Max", "Mean"]);
  assert.deepEqual(
    columns.map((c) => c.type),
    ["integer", "integer", "decimal", "decimal", "decimal"]
  );
  const row = projectedRow(columns, ["   0", "   0", "    0.0", " 123.50", " 1.25"], 1);
  assert.deepEqual(
    row.cells.map((c) => c.exact),
    ["0", "0", "0", "123.5", "1.25"]
  );
  assert.ok(row.cells.every((c) => c.availability === "AVAILABLE"));
  assert.equal(
    projectedRow(nativeColumns("table", ["Min"]), [" 1.5 "], 1).cells[0].availability,
    "INVALID"
  );
  assert.equal(
    projectedRow(nativeColumns("table", ["Table"]), ["  meaningful name  "], 1).label,
    "  meaningful name  "
  );
});
