import test from "node:test";
import assert from "node:assert/strict";
import {
  formatContentSize,
  formatDistribution
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
test("distribution percentages keep precision and distinguish a tiny share from zero", () => {
  assert.equal(formatDistribution("1", 4n), "25%");
  assert.equal(formatDistribution("1", 3n), "33.33%");
  assert.equal(formatDistribution("0", 3n), "0%");
  assert.equal(formatDistribution("1", 1000000n), "<0.01%");
  assert.equal(formatDistribution("0", 0n), "0%");
});
