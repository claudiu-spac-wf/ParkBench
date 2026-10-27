import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
import { nativeFixture } from "../fixtures/reports/fixtures";
import { ReportQueries } from "../../apps/control-plane/src/reports/queries";
import { queryLoadedReportRows } from "../../apps/web/src/features/reports/reportLoadedQuery";

test("grid filters apply across all rows with exact numeric comparisons and cursor binding", async () => {
  const h = reportHarness();
  try {
    const execute = h.runner.execute.bind(h.runner);
    h.runner.execute = async (...args: any[]) => {
      const result = await execute(args[0], args[1], args[2]);
      const [header, original] = nativeFixture("table").trim().split(/\r?\n/);
      const headers = header.split(",");
      const rows = ["9007199254740991", "9007199254740992", "9007199254740993", "?", "0"].map(
        (value, i) => {
          const cells = original.split(",");
          cells[headers.indexOf("Table")] = ["Alpha_1", "Alpha%2", "Alpha_3", "Missing", "Zero"][i];
          cells[headers.indexOf("Size")] = value;
          return cells.join(",");
        }
      );
      fs.writeFileSync(
        path.join(args[1].directory, "raw", "report.tab.txt"),
        header + "\r\n" + rows.join("\r\n") + "\r\n"
      );
      return result;
    };
    const report = h.service.create(request, "grid");
    const done = await eventually(
      () => h.repo.get(report.id),
      (r) => r?.state === "COMPLETED"
    );
    const q = new ReportQueries(h.repo);
    const filters = (value: any[]) => JSON.stringify(value);
    const exact = filters([{ column: "Size", operator: "greaterThan", value: "9007199254740992" }]);
    assert.equal(q.rows(report.id, "table", { columnFilters: exact }).matchingRowCount, "1");
    const literal = filters([{ column: "Table", operator: "contains", value: "%" }]);
    assert.equal(q.rows(report.id, "table", { columnFilters: literal }).matchingRowCount, "1");
    assert.equal(
      q.rows(report.id, "table", {
        columnFilters: filters([
          { column: "Table", operator: "startsWith", value: "Alpha" },
          { column: "Size", operator: "lessThanOrEqualTo", value: "9007199254740992" }
        ])
      }).matchingRowCount,
      "2"
    );
    assert.equal(
      q.rows(report.id, "table", {
        columnFilters: filters([{ column: "Size", operator: "equals", value: "0.00" }])
      }).matchingRowCount,
      "1"
    );
    const page = q.rows(report.id, "table", {
      limit: "1",
      columnFilters: filters([{ column: "Table", operator: "startsWith", value: "Alpha" }])
    });
    assert.ok(page.nextCursor);
    assert.throws(
      () =>
        q.rows(report.id, "table", { limit: "1", cursor: page.nextCursor, columnFilters: exact }),
      /cursor_invalid/
    );
    assert.equal(
      done.artifacts.some((a) => a.filename === "table.csv"),
      true
    );
    assert.equal(q.rows(report.id, "table").matchingRowCount, "5");
    const loaded = q.rows(report.id, "table");
    for (const params of [
      { search: "%" },
      { search: "ALPHA" },
      { search: "_" },
      { sortColumn: "Size", sortDirection: "asc" },
      { sortColumn: "Size", sortDirection: "desc" },
      { sortColumn: "Table", sortDirection: "desc" },
      { concern: "higher_concern" },
      { columnFilters: exact },
      { columnFilters: literal },
      { columnFilters: filters([{ column: "Size", operator: "equals", value: "0.00" }]) },
      { objectKey: loaded.rows[1].objectKey, areaId: loaded.rows[1].areaId }
    ]) {
      const local = queryLoadedReportRows(loaded, new URLSearchParams(params as any));
      const server = q.rows(report.id, "table", params);
      assert.equal(local.matchingRowCount, server.matchingRowCount);
      assert.deepEqual(
        local.rows.map((r) => r.sourceRowOrdinal),
        server.rows.map((r) => r.sourceRowOrdinal)
      );
    }
  } finally {
    h.close();
  }
});

test("grid filters reject unbounded, malformed, unsafe and invalid numeric requests", async () => {
  const h = reportHarness();
  try {
    const report = h.service.create(request, "grid-invalid");
    await eventually(
      () => h.repo.get(report.id),
      (r) => r?.state === "COMPLETED"
    );
    const q = new ReportQueries(h.repo);
    for (const filter of [
      "not-json",
      "{}",
      JSON.stringify(Array(17).fill({ column: "Table", operator: "contains", value: "x" })),
      JSON.stringify([
        { column: "Table; DROP TABLE report_rows", operator: "contains", value: "x" }
      ]),
      JSON.stringify([{ column: "Size", operator: "equals", value: "-1" }]),
      JSON.stringify([{ column: "Size", operator: "greaterThan", value: "1e3" }]),
      JSON.stringify([{ column: "Size", operator: "equals", value: "x".repeat(257) }]),
      JSON.stringify([{ column: "Table", operator: "unsupported", value: "x" }])
    ])
      assert.throws(
        () => q.rows(report.id, "table", { columnFilters: filter }),
        /report_filter_invalid/
      );
  } finally {
    h.close();
  }
});
