import { it } from "node:test";
import assert from "node:assert/strict";
import { writeModule } from "../helpers/table-write";
it(
  "verifies native selective updates on independently preloaded tables",
  { skip: process.env.PARKBENCH_RUN_TABLE_WRITE_TESTS !== "1" },
  async () => {
    const { runSuite } = await writeModule("test-write-workloads");
    const report = await runSuite({
      suite: "updates",
      tables: "all",
      config: process.env.PARKBENCH_ENV_FILE ?? ".env.local"
    });
    assert.equal(report.ok, true);
    assert.ok(report.cases.length >= 32);
    assert.ok(report.cases.every((c: any) => c.ok && !c.skipped));
  }
);
