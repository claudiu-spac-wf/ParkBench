import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ReportQueries } from "../../apps/control-plane/src/reports/queries";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
test("recovery preserves interrupted failure when cancellation arrives during cleanup", async () => {
  const h = reportHarness();
  try {
    h.gate.pause();
    const r = h.service.create(request, "restart");
    r.state = "RUNNING";
    r.startedAt = new Date().toISOString();
    h.repo.save(r);
    h.repo.claim("REPORT", r.id);
    h.runner.cleanupFailures = 1;
    await h.service.recover();
    h.service.cancel(r.id);
    const done = await eventually(
      () => h.repo.get(r.id),
      (r) => r?.state === "FAILED"
    );
    assert.equal(done.failure.code, "report_interrupted");
    assert.equal(done.pendingTerminalState, null);
    assert.equal(done.cleanupRetryAt, null);
  } finally {
    h.close();
  }
});

test("startup repairs legacy padded numeric cells and LOB decimals from retained CSV once", async () => {
  const h = reportHarness();
  try {
    const execute = h.runner.execute.bind(h.runner);
    h.runner.execute = async (...args: any[]) => {
      const output = await execute(args[0], args[1], args[2]);
      for (const [file, changes] of [
        ["report.ix.txt", { Utilization: "   24.5", Factor: "   1.0", Blocks: "100" }],
        ["report.lob.txt", { LOBs: "   1", Min: "    0.0", Max: " 123.50", Mean: " 1.25" }]
      ] as const) {
        const target = path.join(args[1].directory, "raw", file);
        const [header, data] = fs.readFileSync(target, "utf8").trim().split(/\r?\n/);
        const cells = data.split(","),
          names = header.split(",");
        for (const [name, value] of Object.entries(changes)) cells[names.indexOf(name)] = value;
        fs.writeFileSync(target, header + "\r\n" + cells.join(",") + "\r\n");
      }
      return output;
    };
    const created = h.service.create(request, "legacy-numbers");
    const original = await eventually(
      () => h.repo.get(created.id),
      (r) => r?.state === "COMPLETED"
    );
    const query = new ReportQueries(h.repo);
    for (const kind of ["index", "lob"]) {
      const page = query.rows(original.id, kind);
      const row = page.rows[0];
      for (const cell of row.cells) {
        if (cell.semanticType !== "text" && cell.sourceText !== cell.sourceText.trim()) {
          cell.exact = null;
          cell.availability = "INVALID";
          cell.availabilityReason = "Invalid nonnegative measurement";
          for (const finding of cell.assessments ?? []) finding.severity = "unavailable";
          h.repo.db
            .prepare(
              "UPDATE report_cells SET availability=1,numeric_class=2,exponent=0,digits='' WHERE report_id=? AND kind=? AND revision=? AND ordinal=? AND column_id=?"
            )
            .run(
              original.id,
              kind,
              original.projectionRevision,
              row.sourceRowOrdinal,
              cell.columnId
            );
        }
      }
      row.concern = kind === "index" ? "unavailable" : "none";
      h.repo.db
        .prepare(
          "UPDATE report_rows SET document=?,concern=? WHERE report_id=? AND kind=? AND revision=? AND ordinal=?"
        )
        .run(
          JSON.stringify(row),
          row.concern,
          original.id,
          kind,
          original.projectionRevision,
          row.sourceRowOrdinal
        );
      if (kind === "lob") {
        const dataset = original.datasets.find((d) => d.kind === "lob")!;
        for (const column of dataset.columns)
          if (["Min", "Max", "Mean"].includes(column.sourceHeader)) column.type = "integer";
        h.repo.dataset(original.id, dataset);
      }
    }
    const csv = new Map(
      original.artifacts
        .filter((a) => a.kind === "CSV")
        .map((a) => [a.id, fs.readFileSync(path.join(h.artifacts.root, a.relativePath))])
    );
    const executions = h.runner.events.filter((e) => e === "creating").length;
    fs.rmSync(path.join(h.root, "seeds"), { recursive: true });
    await h.service.recover();
    const repaired = h.repo.get(original.id)!;
    assert.notEqual(repaired.projectionRevision, original.projectionRevision);
    assert.equal(repaired.state, "COMPLETED");
    assert.equal(repaired.createdAt, original.createdAt);
    assert.deepEqual(
      repaired.artifacts.map((a) => a.id),
      original.artifacts.map((a) => a.id)
    );
    for (const kind of ["index", "lob"]) {
      const page = query.rows(original.id, kind);
      assert.ok(page.rows[0].cells.every((c) => c.availability === "AVAILABLE"));
      if (kind === "index") {
        assert.equal(page.rows[0].concern, "higher_concern");
        assert.equal(
          query.rows(original.id, "index", {
            columnFilters: JSON.stringify([
              { column: "Utilization", operator: "equals", value: "24.5" }
            ])
          }).matchingRowCount,
          "1"
        );
      } else assert.equal(page.columns.find((c) => c.sourceHeader === "Mean")!.type, "decimal");
    }
    for (const artifact of repaired.artifacts.filter((a) => a.kind === "CSV"))
      assert.deepEqual(
        fs.readFileSync(path.join(h.artifacts.root, artifact.relativePath)),
        csv.get(artifact.id)
      );
    assert.equal(h.runner.events.filter((e) => e === "creating").length, executions);
    assert.ok(repaired.warnings.some((w) => w.code === "report_projection_repaired"));
    await h.service.recover();
    assert.equal(h.repo.get(original.id)!.projectionRevision, repaired.projectionRevision);
  } finally {
    h.close();
  }
});

test("failed retained-number repair preserves the published generation and retries after CSV restoration", async () => {
  const h = reportHarness();
  try {
    const created = h.service.create(request, "repair-retry");
    const report = await eventually(
      () => h.repo.get(created.id),
      (r) => r?.state === "COMPLETED"
    );
    const query = new ReportQueries(h.repo),
      page = query.rows(report.id, "index"),
      row = page.rows[0];
    const cell = row.cells[page.columns.findIndex((c) => c.sourceHeader === "Utilization")];
    cell.sourceText = "   24.999";
    cell.exact = null;
    cell.availability = "INVALID";
    h.repo.db
      .prepare(
        "UPDATE report_rows SET document=? WHERE report_id=? AND kind='index' AND revision=? AND ordinal=?"
      )
      .run(JSON.stringify(row), report.id, report.projectionRevision, row.sourceRowOrdinal);
    h.repo.db
      .prepare(
        "UPDATE report_cells SET text_value=?,availability=1,numeric_class=2 WHERE report_id=? AND kind='index' AND revision=? AND ordinal=? AND column_id=?"
      )
      .run(
        cell.sourceText,
        report.id,
        report.projectionRevision,
        row.sourceRowOrdinal,
        cell.columnId
      );
    const artifact = report.artifacts.find((a) => a.filename === "table.csv")!;
    const file = path.join(h.artifacts.root, artifact.relativePath),
      saved = file + ".fixture-backup";
    fs.renameSync(file, saved);
    await h.service.recover();
    const failed = h.repo.get(report.id)!;
    assert.equal(failed.projectionRevision, report.projectionRevision);
    assert.equal(failed.projectionState, report.projectionState);
    assert.ok(failed.warnings.some((w) => w.code === "report_projection_repair_failed"));
    assert.equal(
      h.repo.db
        .prepare("SELECT count(DISTINCT revision) n FROM report_rows WHERE report_id=?")
        .get(report.id).n,
      1
    );
    fs.renameSync(saved, file);
    await h.service.recover();
    const done = h.repo.get(report.id)!;
    assert.notEqual(done.projectionRevision, report.projectionRevision);
    assert.ok(done.warnings.some((w) => w.code === "report_projection_repaired"));
    assert.equal(
      done.warnings.some((w) => w.code === "report_projection_repair_failed"),
      false
    );
    assert.equal(
      query.rows(report.id, "index").rows[0].cells[cell.columnId].availability,
      "AVAILABLE"
    );
  } finally {
    h.close();
  }
});
