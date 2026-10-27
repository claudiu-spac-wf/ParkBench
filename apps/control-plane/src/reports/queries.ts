import { ReportRepository } from "./repository";
import { parseColumnFilters, appendColumnFilters } from "./column-filters";
import { DATASET_KINDS } from "../../../../packages/contracts/src/database-analysis-report";
const MAX_JSON = 2 * 1024 * 1024;
export function reportLimit(value: unknown, defaultValue: number, max: number) {
  if (value === undefined) return defaultValue;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error("report_limit_invalid");
  return n;
}
function cursorOffset(cursor: string | undefined, binding: string) {
  if (!cursor) return 0;
  if (cursor.length > 8192) throw new Error("report_cursor_invalid");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (parsed.binding !== binding) {
      const old = JSON.parse(parsed.binding),
        next = JSON.parse(binding);
      if (
        old[0] === next[0] &&
        old[1] === next[1] &&
        ((old[0] === "rows" && old[2] === next[2] && old[3] !== next[3]) ||
          (old[0] === "findings" && old[2] !== next[2]))
      )
        throw new Error("report_revision_changed");
      throw new Error();
    }
    if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error();
    return parsed.offset;
  } catch (e) {
    if ((e as Error).message === "report_revision_changed") throw e;
    throw new Error("report_cursor_invalid");
  }
}
function cursor(binding: string, offset: number) {
  return Buffer.from(JSON.stringify({ binding, offset })).toString("base64url");
}
export class ReportQueries {
  constructor(readonly repo: ReportRepository) {}
  require(id: string) {
    const r = this.repo.get(id);
    if (!r) throw new Error("report_not_found");
    return r;
  }
  history(q: any = {}) {
    const limit = reportLimit(q.limit, 50, 100),
      binding = JSON.stringify(["history", q.seedAssetId ?? null, q.type ?? null, q.state ?? null]),
      offset = cursorOffset(q.cursor, binding);
    if (
      (q.type && !["DBANALYS", "IDXANALYS", "TABANALYS"].includes(q.type)) ||
      (q.state && !["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(q.state))
    )
      throw new Error("report_filter_invalid");
    const conditions: string[] = [],
      params: any[] = [];
    for (const [key, expression] of [
      ["seedAssetId", "json_extract(document,'$.seedSnapshot.assetId')"],
      ["type", "json_extract(document,'$.type')"],
      ["state", "state"]
    ])
      if (q[key]) {
        conditions.push(expression + "=?");
        params.push(q[key]);
      }
    const rows = this.repo.db
      .prepare(
        `SELECT id FROM database_reports ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY queue_sequence DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit + 1, offset) as any[];
    const items = [];
    for (const row of rows.slice(0, limit)) {
      const report = this.require(row.id);
      if (Buffer.byteLength(JSON.stringify([...items, report])) > MAX_JSON) break;
      items.push(report);
    }
    if (!items.length && rows.length) throw new Error("report_row_display_limit");
    const hasMore = offset + items.length < offset + rows.length;
    return { items, nextCursor: hasMore ? cursor(binding, offset + items.length) : null, hasMore };
  }
  summary(id: string) {
    const report = this.require(id);
    if (!report.projectionRevision)
      return {
        status: report.projectionState,
        reason: "No published projection is available",
        reportId: id
      };
    const row = this.repo.db
      .prepare("SELECT document FROM report_summaries WHERE report_id=? AND revision=?")
      .get(id, report.projectionRevision) as any;
    return row
      ? JSON.parse(row.document)
      : { status: "UNAVAILABLE", reason: "Retained projection unavailable; CSV remains available" };
  }
  rows(id: string, kind: string, q: any = {}) {
    const report = this.require(id),
      revision = report.projectionRevision;
    if (!DATASET_KINDS.includes(kind as any)) throw new Error("report_dataset_invalid");
    const dataset = report.datasets.find((d) => d.kind === kind);
    if (!dataset || !revision)
      return {
        reportId: id,
        datasetKind: kind,
        revision,
        columns: dataset?.columns ?? [],
        rows: [],
        matchingRowCount: "0",
        nextCursor: null,
        hasMore: false,
        coverage: dataset ?? null
      };
    const search = q.search ?? "";
    if (typeof search !== "string" || search.length > 256) throw new Error("report_search_invalid");
    const concern = q.concern ?? "all",
      direction = q.sortDirection ?? "asc";
    if (
      !["all", "review", "higher_concern", "unavailable", "none"].includes(concern) ||
      !["asc", "desc"].includes(direction)
    )
      throw new Error("report_filter_invalid");
    let column = -1;
    if (q.sortColumn !== undefined) {
      column = dataset.columns.findIndex(
        (c) => String(c.ordinal) === q.sortColumn || c.sourceHeader === q.sortColumn
      );
      if (column < 0) throw new Error("report_sort_invalid");
    }
    if (
      q.areaId !== undefined &&
      !this.repo.db
        .prepare(
          "SELECT 1 FROM report_rows WHERE report_id=? AND kind=? AND revision=? AND area_id=? LIMIT 1"
        )
        .get(id, kind, revision, q.areaId)
    )
      throw new Error("report_area_invalid");
    const columnFilters = parseColumnFilters(q.columnFilters, dataset.columns);
    const limit = reportLimit(q.limit, 100, 250),
      binding = JSON.stringify([
        "rows",
        id,
        kind,
        revision,
        search,
        q.areaId ?? null,
        concern,
        q.objectKey ?? null,
        column,
        direction,
        ...(columnFilters.length ? [columnFilters] : [])
      ]),
      offset = cursorOffset(q.cursor, binding),
      where = ["r.report_id=?", "r.kind=?", "r.revision=?"],
      params: any[] = [id, kind, revision];
    if (search) {
      where.push("r.label LIKE ? ESCAPE '\\'");
      params.push("%" + search.replace(/[\\%_]/g, "\\$&") + "%");
    }
    for (const [key, sql] of [
      ["areaId", "area_id"],
      ["objectKey", "object_key"]
    ])
      if (q[key] !== undefined) {
        where.push(`r.${sql}=?`);
        params.push(q[key]);
      }
    if (concern !== "all") {
      where.push("r.concern=?");
      params.push(concern);
    }
    appendColumnFilters(columnFilters, dataset.columns, where, params);
    let join = "",
      order = "r.ordinal ASC";
    if (column >= 0) {
      join = `JOIN report_cells c ON c.report_id=r.report_id AND c.kind=r.kind AND c.revision=r.revision AND c.ordinal=r.ordinal AND c.column_id=${column}`;
      const d = direction === "desc" ? "DESC" : "ASC";
      order =
        dataset.columns[column].type === "text"
          ? `c.availability ASC,c.text_value ${d},r.ordinal ASC`
          : `c.availability ASC,CASE WHEN c.numeric_class=2 THEN 1 ELSE 0 END ASC,c.numeric_class ${d},c.exponent ${d},c.digits ${d},r.ordinal ASC`;
    }
    const condition = where.join(" AND "),
      count = this.repo.db
        .prepare(`SELECT count(*) n FROM report_rows r WHERE ${condition}`)
        .get(...params) as any;
    const records = this.repo.db
      .prepare(
        `SELECT r.document FROM report_rows r ${join} WHERE ${condition} ORDER BY ${order} LIMIT ? OFFSET ?`
      )
      .all(...params, limit + 1, offset) as any[];
    const rows = [];
    let responseBytes = Buffer.byteLength(JSON.stringify({ columns: dataset.columns, rows: [] }));
    for (const record of records.slice(0, limit)) {
      const row = JSON.parse(record.document);
      const rowBytes = Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
      if (responseBytes + rowBytes > MAX_JSON - 4096) break;
      responseBytes += rowBytes;
      rows.push(row);
    }
    if (!rows.length && records.length) throw new Error("report_row_display_limit");
    const hasMore = offset + rows.length < count.n;
    return {
      reportId: id,
      datasetKind: kind,
      revision,
      columns: dataset.columns,
      rows,
      matchingRowCount: String(count.n),
      nextCursor: hasMore ? cursor(binding, offset + rows.length) : null,
      hasMore,
      coverage: dataset
    };
  }
  findings(id: string, q: any = {}) {
    const report = this.require(id),
      revision = report.projectionRevision;
    const limit = reportLimit(q.limit, 100, 250),
      binding = JSON.stringify([
        "findings",
        id,
        revision,
        q.datasetKind ?? null,
        q.severity ?? null,
        q.objectKey ?? null
      ]),
      offset = cursorOffset(q.cursor, binding),
      where = ["report_id=?", "revision=?"],
      params: any[] = [id, revision ?? ""];
    for (const [key, sql] of [
      ["datasetKind", "kind"],
      ["severity", "severity"],
      ["objectKey", "object_key"]
    ])
      if (q[key]) {
        where.push(sql + "=?");
        params.push(key === "severity" ? q[key].toUpperCase() : q[key]);
      }
    const values = this.repo.db
      .prepare(
        `SELECT document FROM report_findings WHERE ${where.join(" AND ")} ORDER BY kind,ordinal LIMIT ? OFFSET ?`
      )
      .all(...params, limit + 1, offset) as any[];
    const items = [];
    for (const value of values.slice(0, limit)) {
      const item = JSON.parse(value.document);
      if (Buffer.byteLength(JSON.stringify([...items, item])) > MAX_JSON - 4096) break;
      items.push(item);
    }
    if (!items.length && values.length) throw new Error("report_row_display_limit");
    const hasMore = values.length > items.length;
    return {
      reportId: id,
      revision,
      items,
      hasMore,
      nextCursor: hasMore ? cursor(binding, offset + items.length) : null
    };
  }
}
