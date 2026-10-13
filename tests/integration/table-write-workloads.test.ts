import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeModule } from "../helpers/table-write";

describe("licensed table-write create acceptance", () => {
  it(
    "executes all-table record evidence without skipped required cases",
    { skip: process.env.PARKBENCH_RUN_TABLE_WRITE_TESTS !== "1" },
    async () => {
      const module = await writeModule("test-write-workloads");
      const report = await module.runSuite({
        suite: "creates",
        tables: "all",
        config: process.env.PARKBENCH_ENV_FILE ?? ".env.local"
      });
      assert.equal(report.ok, true);
      assert.ok(report.cases.length >= 32);
      assert.ok(report.cases.every((c: any) => c.ok === true && !c.skipped));
    }
  );
});
