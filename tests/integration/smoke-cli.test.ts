import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  validateRunContext,
  validateSummaryHeader
} from "../../packages/contracts/src/run-summary";

it("standalone fake smoke submits both variants and retains the current summary/context contracts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-smoke-cli-"));
  try {
    const config = path.join(root, ".env");
    fs.writeFileSync(
      config,
      `PARKBENCH_ARTIFACT_ROOT=${root}/artifacts\nPARKBENCH_DB_PATH=:memory:\n`
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("PARKBENCH_"))
    );
    const output = execFileSync(
      process.execPath,
      [path.resolve("dist/apps/control-plane/src/commands/smoke.js"), "--fake", "--config", config],
      { encoding: "utf8", env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const experiment = JSON.parse(output);
    assert.deepEqual(
      experiment.runs.map((r: any) => r.variantId),
      ["baseline", "variant"]
    );
    for (const run of experiment.runs) {
      assert.ok(["SUCCEEDED", "INCOMPLETE"].includes(run.state));
      assert.equal(run.cleanupStatus, "COMPLETE");
      const context = JSON.parse(
        fs.readFileSync(path.join(root, "artifacts", run.validation.contextPath), "utf8")
      );
      const { rows, ...summary } = JSON.parse(
        fs.readFileSync(path.join(root, "artifacts", run.validation.summaryPath), "utf8")
      );
      assert.equal(rows.length, summary.totalRowCount);
      validateRunContext(context, run.id);
      validateSummaryHeader(summary, run.id);
      assert.ok(summary.totalRowCount > 0);
      assert.equal(context.observed.cleanupStatus, "COMPLETE");
      assert.equal(
        context.requested.parameters["-B"],
        run.variantId === "variant" ? 10000 : undefined
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
