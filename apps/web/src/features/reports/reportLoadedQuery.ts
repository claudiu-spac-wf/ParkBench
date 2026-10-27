import { parseColumnFilters } from "../../../../../packages/contracts/src/database-analysis-query";
import { compareExact, compareNullable } from "../../../../../packages/contracts/src/exact-numeric";

// Match SQLite's default LIKE/NOCASE behavior, rather than folding non-ASCII names.
const fold = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
function binaryCompare(a: string, b: string) {
  if (a === b) return 0;
  const left = a[Symbol.iterator](),
    right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next(),
      y = right.next();
    if (x.done || y.done) return x.done ? -1 : 1;
    const difference = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (difference) return difference < 0 ? -1 : 1;
  }
}
/** Query only complete, immutable loaded data, using the server's numeric and filter rules. */
export function queryLoadedReportRows(base: any, q: URLSearchParams) {
  if (base.hasMore || BigInt(base.rows.length) !== BigInt(base.matchingRowCount))
    throw new Error("report_rows_incomplete");
  const columns = base.columns;
  const filters = parseColumnFilters(q.get("columnFilters") ?? undefined, columns);
  const search = q.get("search") ?? "",
    area = q.get("areaId"),
    objectKey = q.get("objectKey");
  const concern = q.get("concern") ?? "all",
    direction = q.get("sortDirection") ?? "asc";
  if (search.length > 256) throw new Error("report_search_invalid");
  if (
    !["all", "review", "higher_concern", "unavailable", "none"].includes(concern) ||
    !["asc", "desc"].includes(direction)
  )
    throw new Error("report_filter_invalid");
  if (area !== null && !base.rows.some((r) => r.areaId === area))
    throw new Error("report_area_invalid");
  const column = q.has("sortColumn")
    ? columns.findIndex(
        (c) => String(c.ordinal) === q.get("sortColumn") || c.sourceHeader === q.get("sortColumn")
      )
    : -1;
  if (q.has("sortColumn") && column < 0) throw new Error("report_sort_invalid");
  const term = fold(search);
  const rows = base.rows.filter((row) => {
    if (
      (search && !fold(row.label).includes(term)) ||
      (area !== null && row.areaId !== area) ||
      (objectKey !== null && row.objectKey !== objectKey) ||
      (concern !== "all" && row.concern !== concern)
    )
      return false;
    return filters.every((f) => {
      const cell = row.cells[f.column];
      if (columns[f.column].type !== "text") {
        if (cell.availability !== "AVAILABLE" || cell.exact === null) return false;
        const comparison = compareExact(cell.exact, f.value);
        return f.operator === "equals"
          ? comparison === 0
          : f.operator === "greaterThan"
            ? comparison > 0
            : f.operator === "greaterThanOrEqualTo"
              ? comparison >= 0
              : f.operator === "lessThan"
                ? comparison < 0
                : comparison <= 0;
      }
      const value = fold(cell.sourceText),
        text = fold(f.value);
      return f.operator === "equals"
        ? value === text
        : f.operator === "notEquals"
          ? value !== text
          : f.operator === "startsWith"
            ? value.startsWith(text)
            : f.operator === "endsWith"
              ? value.endsWith(text)
              : value.includes(text);
    });
  });
  if (column >= 0)
    rows.sort((a, b) => {
      const x = a.cells[column],
        y = b.cells[column];
      const availability =
        Number(x.availability !== "AVAILABLE") - Number(y.availability !== "AVAILABLE");
      if (availability) return availability;
      const comparison =
        columns[column].type === "text"
          ? binaryCompare(x.sourceText, y.sourceText) * (direction === "desc" ? -1 : 1)
          : compareNullable(x.exact, y.exact, direction as "asc" | "desc");
      return comparison || a.sourceRowOrdinal - b.sourceRowOrdinal;
    });
  return { ...base, rows, matchingRowCount: String(rows.length), nextCursor: null, hasMore: false };
}
