import test from "node:test";
import assert from "node:assert/strict";
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
