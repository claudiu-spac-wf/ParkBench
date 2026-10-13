import { it } from "node:test";
import assert from "node:assert/strict";
import { writeModule } from "../helpers/table-write";
it(
  "verifies invalid inputs, exhausted choices, later writes and selected identity conflicts roll back",
  { skip: process.env.PARKBENCH_RUN_TABLE_WRITE_FAILURES !== "1" },
  async () => {
    const { runSuite } = await writeModule("test-write-workloads");
    const report = await runSuite({
      suite: "failures",
      config: process.env.PARKBENCH_ENV_FILE ?? ".env.local"
    });
    assert.equal(report.ok, true);
    assert.ok(report.cases.length >= 60);
    assert.ok(report.cases.every((c: any) => c.ok && !c.skipped));
  }
);
