import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { Repositories } from "../../apps/control-plane/src/db/repositories";

const foundation = fs.readFileSync(
  "apps/control-plane/src/db/migrations/001_foundation.sql",
  "utf8"
);

test("run artifact polling seeks only its owner and preserves more than64 ordered identities", (t) => {
  const db = new DatabaseClient();
  t.after(() => db.close());
  db.migrate(foundation);
  const insert = db.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 160; i++) {
    insert.run(
      "foreign-" + i,
      "unrelated-history-" + i,
      "log",
      "foreign/" + i,
      i,
      "json",
      "{invalid-unrelated-metadata",
      "2026-10-01T00:00:00Z",
      1
    );
  }
  const wanted = Array.from({ length: 98 }, (_, i) => ({
    id: "owned-" + i,
    source: { ordinal: i, zero: 0, unavailable: null },
    createdAt: new Date(Date.UTC(2026, 9, 31, 0, 0, Math.floor(i / 2))).toISOString()
  }));
  for (const item of wanted)
    insert.run(
      item.id,
      "active-run",
      "log",
      "active-run/" + item.id,
      0,
      "json",
      JSON.stringify(item.source),
      item.createdAt,
      1
    );
  const originalPrepare = db.db.prepare.bind(db.db);
  let query = "";
  db.db.prepare = (sql: string) => {
    if (/^SELECT \* FROM artifacts WHERE run_id=/.test(sql)) query = sql;
    return originalPrepare(sql);
  };
  const rows = new Repositories(db).listArtifacts("active-run");
  assert.deepEqual(
    rows.map((row) => row.id),
    wanted.map((item) => item.id)
  );
  assert.deepEqual(
    rows.map((row) => row.sourceMetadata),
    wanted.map((item) => item.source)
  );
  assert.ok(query, "inspect the actual public repository query, not a substitute query");
  const plan = originalPrepare("EXPLAIN QUERY PLAN " + query).all("active-run") as Array<{
    detail: string;
  }>;
  assert.ok(
    plan.some((step) => /SEARCH artifacts .*\(run_id=\?\)/.test(step.detail)),
    "history polling must seek the owned artifact range instead of scanning unrelated retained rows: " +
      plan.map((step) => step.detail).join("; ")
  );
  assert.ok(!plan.some((step) => /TEMP B-TREE/.test(step.detail)));
});

test("migration adds bounded artifact lookup to retained databases without rewriting their rows", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-artifact-owner-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "legacy.sqlite");
  const legacy = new DatabaseClient(file);
  legacy.db.exec(foundation);
  legacy.db
    .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)")
    .run(
      "retained",
      "old-run",
      "log",
      "old-run/retained",
      42,
      "json",
      '{"zero":0,"missing":null,"scope":"retained"}',
      "2026-10-30T00:00:00Z",
      1
    );
  const before = legacy.db.prepare("SELECT * FROM artifacts").all();
  legacy.close();
  const current = new DatabaseClient(file);
  t.after(() => current.close());
  current.migrate(foundation);
  current.migrate(foundation);
  assert.deepEqual(current.db.prepare("SELECT * FROM artifacts").all(), before);
  const plan = current.db
    .prepare("EXPLAIN QUERY PLAN SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at")
    .all("old-run") as Array<{ detail: string }>;
  assert.ok(plan.some((step) => /SEARCH artifacts .*\(run_id=\?\)/.test(step.detail)));
  assert.ok(!plan.some((step) => /TEMP B-TREE/.test(step.detail)));
});
