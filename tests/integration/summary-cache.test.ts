import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { Repositories } from "../../apps/control-plane/src/db/repositories";
import { summaryRun, summaryHeader, summaryRow } from "../helpers/summary";
function fixture() {
  const c = new DatabaseClient();
  c.db.exec("PRAGMA foreign_keys=ON");
  c.migrate(
    fs
      .readdirSync("apps/control-plane/src/db/migrations")
      .filter((x) => x.endsWith(".sql"))
      .sort()
      .map((x) => fs.readFileSync(path.join("apps/control-plane/src/db/migrations", x), "utf8"))
      .join("\n")
  );
  const r = new Repositories(c);
  r.saveRun(summaryRun());
  return { c, r };
}
describe("attempt-scoped summary store", () => {
  it("preserves children and legacy summary on repeated parent saves", () => {
    const { c, r } = fixture();
    const token = r.claimSummaryAttempt("run-test");
    r.stageSummaryRows("run-test", "measurement-summary.v1", token, [summaryRow("A")]);
    r.saveRun({ ...summaryRun(), phase: "idle" });
    assert.equal(c.db.prepare("SELECT count(*) AS n FROM run_comparison_summary_rows").get().n, 1);
    assert.deepEqual(r.getRun("run-test").summary, { old: true });
    c.close();
  });
  it("keeps staging private and aborts expired/replaced writer iteration", async () => {
    const { c, r } = fixture();
    const token = r.claimSummaryAttempt("run-test");
    r.stageSummaryRows("run-test", "measurement-summary.v1", token, [
      summaryRow("A"),
      summaryRow("B")
    ]);
    assert.equal(r.pageSummaryRows("run-test").rows.length, 0);
    const iterator = r
      .iterateStagedSummaryRows("run-test", "measurement-summary.v1", token, 1)
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.dimensions.table, "A");
    c.db
      .prepare("UPDATE run_comparison_summaries SET lease_until=0 WHERE run_id=?")
      .run("run-test");
    await assert.rejects(() => iterator.next(), /summary_attempt_stale/);
    const replacement = r.claimSummaryAttempt("run-test");
    assert.notEqual(replacement, token);
    await assert.rejects(async () => {
      for await (const _ of r.iterateStagedSummaryRows(
        "run-test",
        "measurement-summary.v1",
        token
      )) {
      }
    }, /summary_attempt_stale/);
    assert.throws(() =>
      r.stageSummaryRows("run-test", "measurement-summary.v1", token, [summaryRow("C")])
    );
    assert.equal(r.pageSummaryRows("run-test").rows.length, 0);
    c.close();
  });
  it("enforces composite ownership, unique rows, semantic versions and exact publication counts", () => {
    const { c, r } = fixture();
    assert.throws(() => r.claimSummaryAttempt("unknown"));
    const token = r.claimSummaryAttempt("run-test");
    r.stageSummaryRows("run-test", "measurement-summary.v1", token, [
      summaryRow("B"),
      summaryRow("A")
    ]);
    assert.throws(() =>
      r.stageSummaryRows("run-test", "measurement-summary.v1", token, [summaryRow("A")])
    );
    assert.throws(() =>
      r.publishSummary("run-test", "measurement-summary.v1", token, summaryHeader(), {
        id: "x",
        runId: "run-test",
        path: "missing",
        kind: "run_comparison_summary",
        sizeBytes: 1,
        format: "json",
        createdAt: new Date().toISOString(),
        retained: true
      })
    );
    assert.equal(r.pageSummaryRows("run-test").rows.length, 0);
    c.close();
  });
});
