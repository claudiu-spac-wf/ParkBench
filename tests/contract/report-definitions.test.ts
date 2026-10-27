import test from "node:test";
import assert from "node:assert/strict";
import {
  reportDefinitions,
  nativeColumns,
  REPORT_RULES
} from "../../packages/contracts/src/database-analysis-definitions";
test("definitions explain every displayed measurement and preserve version boundaries", () => {
  const d = reportDefinitions();
  assert.ok(d.columns.every((c) => c.description));
  assert.equal(nativeColumns("index", ["Factor"])[0].unit, "ratio");
  assert.equal(REPORT_RULES.length, 3);
  assert.throws(() => reportDefinitions("future"), /version_unavailable/);
  assert.throws(() => reportDefinitions(undefined, "future"), /version_unavailable/);
});
