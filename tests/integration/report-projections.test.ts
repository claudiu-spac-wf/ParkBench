import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
import { nativeFixture } from "../fixtures/reports/fixtures";
import { ReportQueries } from "../../apps/control-plane/src/reports/queries";
test("exact ordering across all rows, missing-last both directions and top20 plus Other reconcile", async () => {
  const h = reportHarness();
  try {
    const execute = h.runner.execute.bind(h.runner);
    h.runner.execute = async (...a: any[]) => {
      const result = await execute(a[0], a[1], a[2]);
      const [header, row] = nativeFixture("table").trim().split(/\r?\n/);
      const values = [
        "9007199254740993",
        "9007199254740992",
        "9007199254740991",
        "0",
        "?",
        ...Array(21).fill("1")
      ];
      const rows = values.map((v, i) =>
        (() => {
          const cells = row.replace("Customer", "Object_" + i).split(",");
          cells[header.split(",").indexOf("Size")] = v;
          return cells.join(",");
        })()
      );
      fs.writeFileSync(
        path.join(a[1].directory, "raw", "report.tab.txt"),
        header + "\r\n" + rows.join("\r\n") + "\r\n"
      );
      return result;
    };
    const r = h.service.create(request, "projection");
    await eventually(
      () => h.repo.get(r.id),
      (r) => r?.state === "COMPLETED"
    );
    const q = new ReportQueries(h.repo);
    for (const d of ["asc", "desc"]) {
      const page = q.rows(r.id, "table", { sortColumn: "Size", sortDirection: d, limit: "250" });
      const size = page.columns.findIndex((c) => c.sourceHeader === "Size");
      assert.equal(page.rows.at(-1).cells[size].sourceText, "?");
      assert.equal(page.rows[0].cells[size].sourceText, d === "asc" ? "0" : "9007199254740993");
    }
    assert.equal(q.summary(r.id).objects.length, 21);
    assert.ok(q.summary(r.id).objects.some((p) => p.label === "Other"));
    assert.equal(q.summary(r.id).totals.find((t) => t.datasetKind === "table").complete, false);
  } finally {
    h.close();
  }
});
import { rebuildRetainedProjection } from "../../apps/control-plane/src/reports/rebuild";
test("rebuild uses captured CSV mappings after the source seed is removed", async () => {
  const h = reportHarness();
  try {
    const r = h.service.create(request, "rebuild");
    const original = await eventually(
      () => h.repo.get(r.id),
      (v) => v?.state === "COMPLETED"
    );
    const q = new ReportQueries(h.repo),
      before = q.summary(r.id);
    fs.rmSync(path.join(h.root, "seeds"), { recursive: true });
    const revision = await rebuildRetainedProjection(h.repo, h.artifacts, r.id);
    assert.notEqual(revision, original.projectionRevision);
    assert.deepEqual(q.summary(r.id).totals, before.totals);
    assert.equal(h.runner.events.filter((e) => e === "creating").length, 1);
    const old = Buffer.from(
      JSON.stringify({
        binding: JSON.stringify([
          "rows",
          r.id,
          "table",
          original.projectionRevision,
          "",
          null,
          "all",
          null,
          -1,
          "asc"
        ]),
        offset: 1
      })
    ).toString("base64url");
    assert.throws(() => q.rows(r.id, "table", { cursor: old }), /report_revision_changed/);
  } finally {
    h.close();
  }
});
