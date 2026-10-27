import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { ReportRepository } from "../../apps/control-plane/src/reports/repository";
test("host claims are exclusive, fenced, and waiting reports block direct experiments", () => {
  const db = new DatabaseClient();
  db.db.exec(
    fs.readFileSync("apps/control-plane/src/db/migrations/008_database_reports.sql", "utf8")
  );
  const repo = new ReportRepository(db);
  const token = repo.claim("EXPERIMENT", "one");
  assert.ok(token);
  assert.equal(repo.claim("REPORT", "two"), undefined);
  assert.equal(repo.release("wrong"), false);
  assert.equal(repo.release(token!), true);
  db.db.prepare("INSERT INTO database_reports(id,state,document) VALUES('r','QUEUED','{}')").run();
  assert.equal(repo.claim("EXPERIMENT", "three"), undefined);
  assert.ok(repo.claim("REPORT", "r"));
  db.close();
});
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
test("reports dispatch FIFO and keep the entire active host claim without starting paused experiments", async () => {
  const h = reportHarness();
  try {
    const token = h.repo.claim("EXPERIMENT", "whole-matrix");
    h.runner.silent = true;
    const first = h.service.create(request, "first"),
      second = h.service.create(request, "second");
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(h.repo.get(first.id).state, "QUEUED");
    assert.equal(h.repo.get(second.id).state, "QUEUED");
    assert.equal(h.repo.claim("EXPERIMENT", "bypass"), undefined);
    h.gate.release(token!);
    await eventually(
      () => h.repo.get(first.id),
      (r) => r?.state === "RUNNING"
    );
    assert.equal(h.repo.get(second.id).state, "QUEUED");
    h.service.cancel(first.id);
    await eventually(
      () => h.repo.get(first.id),
      (r) => r?.state === "CANCELLED"
    );
    await eventually(
      () => h.repo.get(second.id),
      (r) => r?.state === "RUNNING"
    );
    h.service.cancel(second.id);
    await eventually(
      () => h.repo.get(second.id),
      (r) => r?.state === "CANCELLED"
    );
    assert.equal(h.repo.currentClaim(), undefined);
  } finally {
    h.close();
  }
});
test("queued cancellation creates no native resource and wakes FIFO continuation", async () => {
  const h = reportHarness();
  try {
    h.gate.pause();
    const first = h.service.create(request, "cancel-queued"),
      second = h.service.create(request, "following");
    h.service.cancel(first.id);
    assert.equal(h.repo.resources(first.id).length, 0);
    h.gate.resume();
    await eventually(
      () => h.repo.get(second.id),
      (r) => r?.state === "COMPLETED"
    );
    assert.equal(h.repo.get(first.id).state, "CANCELLED");
  } finally {
    h.close();
  }
});
