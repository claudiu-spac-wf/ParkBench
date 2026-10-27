import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { tenThousandTables } from "../fixtures/reports/fixtures";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
import { ReportQueries } from "../../apps/control-plane/src/reports/queries";
test("real retained 10k query index meets summary and interaction budgets", async () => {
  const h = reportHarness();
  try {
    const original = h.runner.execute.bind(h.runner);
    h.runner.execute = async (...args: any[]) => {
      const result = await original(args[0], args[1], args[2]);
      fs.writeFileSync(path.join(args[1].directory, "raw", "report.tab.txt"), tenThousandTables());
      return result;
    };
    const r = h.service.create({ ...request, type: "TABANALYS" }, "10k");
    await eventually(
      () => h.repo.get(r.id),
      (v) => v?.state === "COMPLETED",
      60000
    );
    const q = new ReportQueries(h.repo),
      start = performance.now(),
      summary = q.summary(r.id),
      first = q.rows(r.id, "table");
    assert.equal(first.matchingRowCount, "10000");
    const firstMs = performance.now() - start;
    assert.ok(firstMs <= 5000);
    const timings = [];
    for (let i = 0; i < 20; i++) {
      const begin = performance.now();
      q.rows(r.id, "table", {
        search: i % 2 ? "Table_0" : "Table_099",
        sortColumn: "Size",
        sortDirection: i % 2 ? "asc" : "desc",
        concern: "all"
      });
      timings.push(performance.now() - begin);
    }
    timings.sort((a, b) => a - b);
    assert.ok(timings[18] <= 2000);
    console.log(
      "REPORT_PERFORMANCE",
      JSON.stringify({
        rows: 10000,
        columns: first.columns.length,
        fixtureBytes: Buffer.byteLength(tenThousandTables()),
        summaryAndFirstRowsMs: firstMs,
        p95QueryMs: timings[18],
        node: process.version
      })
    );
  } finally {
    h.close();
  }
});
