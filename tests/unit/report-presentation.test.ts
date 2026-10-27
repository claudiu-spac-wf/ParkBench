import test from "node:test";
import assert from "node:assert/strict";
import {
  formatContentSize,
  formatDistribution,
  formatReportCell,
  reportColumnLabel
} from "../../apps/web/src/features/reports/reportPresentation";
test("content sizes use decimal units with exact rounding across boundaries and large values", () => {
  for (const [input, expected] of [
    ["0", "0B"],
    ["999", "999B"],
    ["25000", "25KB"],
    ["2000000", "2MB"],
    ["25780000000", "25.78GB"],
    ["999999", "1MB"],
    ["9007199254740993", "9.01PB"],
    ["1000000000000000000000000000000", "1000000YB"]
  ])
    assert.equal(formatContentSize(input), expected);
  for (const invalid of ["?", "-1", "1.5", "", "1e6"])
    assert.equal(formatContentSize(invalid), "Unavailable");
});
import { nativeColumns } from "../../packages/contracts/src/database-analysis-definitions";
import { projectedRow } from "../../apps/control-plane/src/reports/native-parser";
test("grid labels omit unit suffixes and values carry percent/byte units", () => {
  const columns = nativeColumns("index", ["Levels", "Utilization", "Factor", "Size"]);
  assert.deepEqual(columns.map(reportColumnLabel), ["Levels", "Utilization", "Factor", "Size"]);
  const row = projectedRow(columns, ["1", "   56.5", "   1.0", "123"], 1);
  assert.deepEqual(
    row.cells.map((c, i) => formatReportCell(c, columns[i])),
    ["1", "56.5%", "1.0", "123b"]
  );
  const large = projectedRow(nativeColumns("table", ["Size"]), ["9007199254740993"], 1);
  assert.equal(formatReportCell(large.cells[0], nativeColumns("table", ["Size"])[0]), "9.01PB");
  const decimalColumns = nativeColumns("lob", ["Mean"]);
  assert.equal(
    formatReportCell(projectedRow(decimalColumns, ["   1.25"], 1).cells[0], decimalColumns[0]),
    "1.25b"
  );
  assert.equal(
    formatReportCell(projectedRow(decimalColumns, [" -1 "], 1).cells[0], decimalColumns[0]),
    "-1"
  );
  assert.equal(columns[0].csvHeader, "Levels [levels]");
});
test("distribution percentages keep precision and distinguish a tiny share from zero", () => {
  assert.equal(formatDistribution("1", 4n), "25%");
  assert.equal(formatDistribution("1", 3n), "33.33%");
  assert.equal(formatDistribution("0", 3n), "0%");
  assert.equal(formatDistribution("1", 1000000n), "<0.01%");
  assert.equal(formatDistribution("0", 0n), "0%");
});
