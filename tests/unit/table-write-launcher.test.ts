import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeModule } from "../helpers/table-write";
it("retains failed native reports for missing configuration and invalid suites", async () => {
  const module = await writeModule("test-write-workloads");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-write-launcher-"));
  try {
    const report = path.join(root, "failed.json");
    const config = path.join(root, "valid.env");
    fs.writeFileSync(config, "# Unit-only configuration\n");
    await assert.rejects(
      module.runSuite({ suite: "records", config: path.join(root, "absent.env"), report })
    );
    let result = JSON.parse(fs.readFileSync(report, "utf8"));
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.deepEqual(result.cases, []);
    assert.ok(result.completedAt);
    await assert.rejects(
      module.runSuite({ suite: "unknown", config, report }),
      /write_test_suite_invalid/
    );
    result = JSON.parse(fs.readFileSync(report, "utf8"));
    assert.equal(result.ok, false);
    assert.match(result.error, /write_test_suite_invalid/);
    assert.equal(result.purpose, "workload-acceptance");
    assert.deepEqual(result.cases, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
