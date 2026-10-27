import test from "node:test";
import assert from "node:assert/strict";
import { ReportQueries } from "../../apps/control-plane/src/reports/queries";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
test("retained summary, exact source rows, literal search, bound cursors and findings", async () => {
  const h = reportHarness();
  try {
    const report = h.service.create(request, "results");
    await eventually(
      () => h.repo.get(report.id),
      (r) => r?.state === "COMPLETED"
    );
    const q = new ReportQueries(h.repo);
    const summary = q.summary(report.id);
    assert.equal(summary.totals.find((t) => t.datasetKind === "table").value, "9007199254740993");
    assert.equal(summary.concernObjectCount, "2");
    const rows = q.rows(report.id, "table", { sortColumn: "Size", sortDirection: "desc" });
    assert.equal(
      rows.rows[0].cells.find((_, i) => rows.columns[i].sourceHeader === "Size").sourceText,
      "9007199254740993"
    );
    assert.equal(q.rows(report.id, "table", { search: "%" }).matchingRowCount, "0");
    assert.throws(
      () =>
        q.rows(report.id, "table", {
          search: "x",
          cursor: Buffer.from(JSON.stringify({ binding: "wrong", offset: 0 })).toString("base64url")
        }),
      /cursor_invalid/
    );
    assert.ok(q.findings(report.id).items.some((f) => f.severity === "HIGHER_CONCERN"));
  } finally {
    h.close();
  }
});
test("bounded pages reject invalid limits, stale query cursors and oversized rows without changing CSV", async () => {
  const h = reportHarness();
  try {
    const r = h.service.create(request, "bounds");
    const done = await eventually(
      () => h.repo.get(r.id),
      (v) => v?.state === "COMPLETED"
    );
    const q = new ReportQueries(h.repo);
    assert.throws(() => q.history({ limit: "101" }), /limit_invalid/);
    assert.throws(() => q.rows(r.id, "table", { limit: "251" }), /limit_invalid/);
    assert.throws(() => q.findings(r.id, { limit: "251" }), /limit_invalid/);
    assert.throws(() => q.rows(r.id, "table", { search: "x".repeat(257) }), /search_invalid/);
    assert.throws(
      () => q.rows(r.id, "table", { sortColumn: "Size; DROP TABLE report_rows" }),
      /sort_invalid/
    );
    const row = q.rows(r.id, "table").rows[0];
    row.cells[0].sourceText = "x".repeat(2 * 1024 * 1024);
    h.repo.db
      .prepare("UPDATE report_rows SET document=? WHERE report_id=? AND kind='table'")
      .run(JSON.stringify(row), r.id);
    assert.throws(() => q.rows(r.id, "table"), /row_display_limit/);
    assert.ok(done.artifacts.some((a) => a.kind === "CSV" && a.datasetKind === "table"));
  } finally {
    h.close();
  }
});

test("bounded row batches account for UTF-8 and JSON escaping without losing cursor rows", async () => {
  const h = reportHarness();
  try {
    const created = h.service.create(request, "batch-bytes");
    const report = await eventually(
      () => h.repo.get(created.id),
      (r) => r?.state === "COMPLETED"
    );
    const query = new ReportQueries(h.repo);
    const original = query.rows(report.id, "table").rows[0];
    h.repo.db.prepare("DELETE FROM report_rows WHERE report_id=? AND kind='table'").run(report.id);
    const insert = h.repo.db.prepare("INSERT INTO report_rows VALUES(?,?,?,?,?,?,?,?,?)");
    for (let ordinal = 0; ordinal < 12; ordinal++) {
      const row = JSON.parse(JSON.stringify(original));
      row.sourceRowOrdinal = ordinal;
      row.cells[0].sourceText = '💾"\\\n'.repeat(40000);
      insert.run(
        report.id,
        "table",
        report.projectionRevision,
        ordinal,
        row.objectKey,
        row.label,
        row.areaId,
        row.concern,
        JSON.stringify(row)
      );
    }
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = query.rows(report.id, "table", { limit: "250", ...(cursor ? { cursor } : {}) });
      assert.ok(page.rows.length > 0 && page.rows.length < 12);
      assert.ok(
        Buffer.byteLength(JSON.stringify({ columns: page.columns, rows: page.rows })) <=
          2 * 1024 * 1024 - 4096
      );
      assert.equal(page.matchingRowCount, "12");
      seen.push(...page.rows.map((r) => r.sourceRowOrdinal));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(
      seen,
      Array.from({ length: 12 }, (_, i) => i)
    );
  } finally {
    h.close();
  }
});
