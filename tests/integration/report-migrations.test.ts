import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
test("report migration is additive and repeatable with no live catalog/run references", () => {
  const db = new DatabaseSync(":memory:");
  const sql = fs.readFileSync(
    "apps/control-plane/src/db/migrations/008_database_reports.sql",
    "utf8"
  );
  db.exec("CREATE TABLE history(id TEXT); INSERT INTO history VALUES('kept')");
  db.exec(sql);
  db.exec(sql);
  for (const table of [
    "database_reports",
    "report_datasets",
    "report_artifacts",
    "report_resources"
  ])
    assert.equal(
      db
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all()
        .some((v: any) => ["runs", "control_assets"].includes(v.table)),
      false
    );
  assert.equal(db.prepare("SELECT id FROM history").get().id, "kept");
  db.close();
});
test("dataset and row identities are unique, all five states persist and unknown states fail", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync("apps/control-plane/src/db/migrations/008_database_reports.sql", "utf8"));
  for (const state of ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"])
    db.prepare("INSERT INTO database_reports(id,state,document) VALUES(?,?,?)").run(
      state,
      state,
      "{}"
    );
  assert.throws(() =>
    db
      .prepare("INSERT INTO database_reports(id,state,document) VALUES('invalid','UNKNOWN','{}')")
      .run()
  );
  db.prepare("INSERT INTO report_datasets VALUES('report','table','{}')").run();
  assert.throws(() =>
    db.prepare("INSERT INTO report_datasets VALUES('report','table','{}')").run()
  );
  assert.equal(db.prepare("SELECT count(*) n FROM database_reports").get().n, 5);
  db.close();
});
