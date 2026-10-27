import test from "node:test";
import assert from "node:assert/strict";
import { queryLoadedReportRows } from "../../apps/web/src/features/reports/reportLoadedQuery";
import { nativeColumns } from "../../packages/contracts/src/database-analysis-definitions";

const columns = nativeColumns("table", ["Table", "Size"]);
const rows = [
  ["alpha%_", "9007199254740993"],
  ["Äname", "9007199254740992"],
  ["äname", "?"],
  ["\uE000", "0"],
  ["💾", "2.00"]
].map(([label, size], sourceRowOrdinal) => ({
  sourceRowOrdinal,
  label,
  objectKey: label,
  areaId: "7",
  concern: "none",
  cells: [label, size].map((sourceText, i) => ({
    sourceText,
    availability: sourceText === "?" ? "MISSING" : "AVAILABLE",
    exact: i === 1 && sourceText !== "?" ? size : null
  }))
}));
const base = { columns, rows, matchingRowCount: "5", hasMore: false, revision: "stable" };
const query = (params: Record<string, string>) =>
  queryLoadedReportRows(base, new URLSearchParams(params));
test("fully loaded queries preserve exact numeric sorting/filtering and missing-last behavior", () => {
  for (const sortDirection of ["asc", "desc"]) {
    const result = query({ sortColumn: "Size", sortDirection });
    assert.equal(result.rows.at(-1).label, "äname");
    assert.equal(
      result.rows[0].cells[1].sourceText,
      sortDirection === "asc" ? "0" : "9007199254740993"
    );
  }
  assert.equal(
    query({
      columnFilters: JSON.stringify([
        { column: "Size", operator: "greaterThan", value: "9007199254740992" }
      ])
    }).matchingRowCount,
    "1"
  );
  assert.equal(
    query({
      columnFilters: JSON.stringify([{ column: "Size", operator: "equals", value: "2.000" }])
    }).rows[0].label,
    "💾"
  );
  assert.equal(base.rows[0].label, "alpha%_");
});
test("loaded text queries match SQLite literal, ASCII case and Unicode ordering semantics", () => {
  assert.equal(query({ search: "%_" }).matchingRowCount, "1");
  assert.equal(query({ search: "ALPHA" }).matchingRowCount, "1");
  assert.deepEqual(
    query({ search: "ä" }).rows.map((r) => r.label),
    ["äname"]
  );
  assert.deepEqual(
    query({ sortColumn: "Table" }).rows.map((r) => r.label),
    ["alpha%_", "Äname", "äname", "\uE000", "💾"]
  );
  assert.equal(query({ areaId: "7", concern: "none", objectKey: "Äname" }).matchingRowCount, "1");
  assert.throws(() => query({ areaId: "missing" }), /report_area_invalid/);
  assert.throws(
    () =>
      query({
        columnFilters: JSON.stringify([{ column: "Size", operator: "equals", value: "1e5" }])
      }),
    /report_filter_invalid/
  );
  assert.throws(
    () => queryLoadedReportRows({ ...base, hasMore: true }, new URLSearchParams()),
    /report_rows_incomplete/
  );
});
