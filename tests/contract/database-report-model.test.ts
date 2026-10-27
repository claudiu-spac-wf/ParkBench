import test from "node:test";
import assert from "node:assert/strict";
import {
  validateReportRequest,
  REPORT_VERSION
} from "../../packages/contracts/src/database-analysis-report";
test("strict requests accept only the three independent tools", () => {
  for (const type of ["DBANALYS", "IDXANALYS", "TABANALYS"]) {
    const v = {
      contractVersion: REPORT_VERSION,
      family: "database-analysis",
      seedAssetId: "seed",
      type
    };
    assert.equal(validateReportRequest(v), true);
    for (const field of ["timeout", "path", "command", "experimentId"])
      assert.equal(validateReportRequest({ ...v, [field]: 1 }), false);
  }
});
