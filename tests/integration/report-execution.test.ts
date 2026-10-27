import test from "node:test";
import assert from "node:assert/strict";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
test("three independent scopes finish and retain unit-bearing CSV", async () => {
  const h = reportHarness();
  try {
    for (const type of ["DBANALYS", "IDXANALYS", "TABANALYS"]) {
      const r = h.service.create({ ...request, type }, type);
      const done = await eventually(
        () => h.repo.get(r.id),
        (r) => r?.state === "COMPLETED"
      );
      assert.deepEqual(done.executionSnapshot.options, [
        "-csoutput",
        "-fieldsep",
        ",",
        "-verbose",
        "-csfilePrefix",
        "report"
      ]);
      assert.equal(done.cleanupState, "CONFIRMED");
      assert.equal(done.datasets.length, 5);
      assert.equal(done.projectionState, "READY");
      assert.ok(done.artifacts.some((a) => a.kind === "CSV"));
    }
    assert.equal(h.repo.currentClaim(), undefined);
  } finally {
    h.close();
  }
});
test("silent reports have no inactivity deadline; cancellation holds capacity through cleanup failures", async () => {
  const h = reportHarness();
  try {
    h.runner.silent = true;
    h.runner.cleanupFailures = 2;
    const r = h.service.create(request, "quiet");
    await eventually(
      () => h.runner.events,
      (x) => x.includes("running")
    );
    h.service.cancel(r.id);
    const pending = await eventually(
      () => h.repo.get(r.id),
      (r) => r?.cleanupState === "FAILED"
    );
    assert.equal(pending.state, "RUNNING");
    assert.equal(pending.pendingTerminalState, "CANCELLED");
    assert.ok(pending.cleanupRetryAt);
    assert.ok(h.repo.currentClaim());
    h.service.cancel(r.id);
    await eventually(
      () => h.repo.get(r.id),
      (r) => r?.state === "CANCELLED"
    );
    assert.equal(h.repo.currentClaim(), undefined);
  } finally {
    h.close();
  }
});

test("cancellation during delayed creation cannot publish terminal before creation resolves", async () => {
  const h = reportHarness();
  try {
    let release: () => void;
    h.runner.creation = new Promise<void>((r) => (release = r));
    h.runner.silent = true;
    const report = h.service.create(request, "creation-race");
    await eventually(
      () => h.runner.events,
      (v) => v.includes("creating")
    );
    const cancelling = h.service.cancel(report.id);
    assert.equal(cancelling.pendingTerminalState, "CANCELLED");
    assert.equal(cancelling.state, "RUNNING");
    assert.ok(h.repo.currentClaim());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.repo.get(report.id).state, "RUNNING");
    release!();
    await eventually(
      () => h.repo.get(report.id),
      (r) => r?.state === "CANCELLED"
    );
    assert.ok(h.runner.events.includes("cleanup"));
  } finally {
    h.close();
  }
});
for (const mode of ["warning", "error", "truncation", "storage"] as const)
  test(`retains classified ${mode} separately from concern findings`, async () => {
    const h = reportHarness();
    try {
      h.runner.executionWarning = mode === "warning";
      h.runner.executionError = mode === "error" ? "report_execution_failed" : undefined;
      h.runner.truncateOutput = mode === "truncation";
      h.runner.storageFailure = mode === "storage";
      const r = h.service.create(request, mode);
      const done = await eventually(
        () => h.repo.get(r.id),
        (r) => r?.state === (mode === "warning" ? "COMPLETED" : "FAILED")
      );
      if (mode === "warning")
        assert.ok(done.warnings.some((w) => w.code === "report_execution_warning"));
      else
        assert.equal(
          done.failure.code,
          mode === "truncation"
            ? "report_output_invalid"
            : mode === "storage"
              ? "report_storage_failed"
              : "report_execution_failed"
        );
      if (mode === "truncation")
        assert.ok(done.artifacts.some((a) => a.kind === "CSV" && !a.complete));
      assert.equal(h.repo.currentClaim(), undefined);
    } finally {
      h.close();
    }
  });
import { ManualReportClock } from "../fixtures/reports/fake-analysis-runner";
import { setImmediate } from "node:timers/promises";
test("cleanup retries exactly five seconds after failure completion with one serialized worker", async () => {
  const h = reportHarness();
  try {
    const clock = new ManualReportClock();
    h.service.options.clock = clock;
    h.service.options.cleanupRetryMs = undefined;
    h.runner.cleanupFailures = 1;
    h.runner.silent = true;
    const r = h.service.create(request, "virtual-clock");
    await eventually(
      () => h.runner.events,
      (v) => v.includes("running")
    );
    h.service.cancel(r.id);
    await eventually(
      () => h.repo.get(r.id),
      (r) => r?.pendingTerminalState === "CANCELLED"
    );
    await new Promise((r) => setTimeout(r, 5));
    clock.advance(0);
    await setImmediate();
    const pending = h.repo.get(r.id);
    assert.equal(pending.cleanupState, "FAILED");
    assert.equal(Date.parse(pending.cleanupRetryAt) - clock.now(), 5000);
    h.service.cancel(r.id);
    clock.advance(4999);
    await setImmediate();
    assert.equal(h.runner.events.filter((v) => v === "cleanup").length, 1);
    clock.advance(1);
    await eventually(
      () => h.repo.get(r.id),
      (r) => r?.state === "CANCELLED"
    );
    assert.equal(h.runner.events.filter((v) => v === "cleanup").length, 2);
  } finally {
    h.close();
  }
});
