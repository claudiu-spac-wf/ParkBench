import { it } from "node:test";
import assert from "node:assert/strict";
import { writeModule } from "../helpers/table-write";
it(
  "proves native HTTP transaction outcomes and real sixty-second StopAfter rollback",
  { skip: process.env.PARKBENCH_RUN_TABLE_WRITE_RUNNER !== "1" },
  async () => {
    const { runSuite } = await writeModule("test-write-workloads");
    const report = await runSuite({
      suite: "runner",
      config: process.env.PARKBENCH_ENV_FILE ?? ".env.local"
    });
    assert.equal(report.ok, true);
    assert.ok(report.cases.length >= 9);
    assert.ok(report.cases.every((c: any) => c.ok && !c.skipped));
  }
);
