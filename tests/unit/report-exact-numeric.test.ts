import test from "node:test";
import assert from "node:assert/strict";
import {
  canonical,
  compareExact,
  sumExact,
  compareNullable
} from "../../apps/control-plane/src/reports/exact-numeric";
test("exact integers, fractional prefixes, scale and sum", () => {
  assert.equal(compareExact("9007199254740992", "9007199254740993"), -1);
  assert.equal(compareExact("0.19", "0.2"), -1);
  assert.equal(compareExact("1.50", "1.5"), 0);
  assert.equal(canonical("0001.5000"), "1.5");
  assert.equal(canonical("0.000"), "0");
  assert.equal(canonical("-1"), null);
  assert.equal(canonical("?"), null);
  assert.equal(sumExact(["9007199254740993", "0.007", "2.003"]), "9007199254740995.01");
  for (const direction of ["asc", "desc"] as const)
    assert.equal(compareNullable(null, "0", direction), 1);
});
