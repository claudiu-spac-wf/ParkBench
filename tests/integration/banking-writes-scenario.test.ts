import { it } from "node:test";
import assert from "node:assert/strict";
import { writeModule } from "../helpers/table-write";
it(
  "verifies all operations and full native banking-write measurements before cleanup",
  { skip: process.env.PARKBENCH_RUN_TABLE_WRITE_SCENARIO !== "1" },
  async () => {
    const { runSuite } = await writeModule("test-write-workloads");
    const report = await runSuite({
      suite: "scenario",
      config: process.env.PARKBENCH_ENV_FILE ?? ".env.local",
      report: ".parkbench/validation/banking-writes.json"
    });
    assert.equal(report.ok, true);
    assert.ok(report.cases.length >= 18);
    assert.ok(report.cases.every((c: any) => c.ok && !c.skipped));
    assert.equal(report.measured.copies.length, 2);
  }
);
