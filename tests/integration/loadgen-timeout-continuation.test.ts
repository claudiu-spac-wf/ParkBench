import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import scenario from "../../examples/scenarios/crud-rest.json";
import { runLoadgen } from "../../apps/loadgen/src/runner";
import { loadgenExitCode } from "../../apps/loadgen/src/exit-codes";

for (const transport of ["abort", "http408"] as const)
  test(`one ${transport} timeout preserves failure evidence while other workers and all phases continue`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-loadgen-timeout-")),
      shutdown = path.join(root, "shutdown");
    const prior = process.env.PARKBENCH_PHASE_SCALE;
    let requests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.end("ok");
        return;
      }
      const n = ++requests;
      if (n === 1) {
        if (transport === "http408") {
          res.statusCode = 408;
          res.setHeader("content-type", "application/json");
          res.end('{"error":"bounded"}');
        }
        return;
      }
      setTimeout(() => res.end("ok"), 3);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      process.env.PARKBENCH_PHASE_SCALE = "0.25";
      const began = Date.now();
      const summary = await runLoadgen({
        scenario: {
          ...scenario,
          target: { ...scenario.target, timeoutMs: 100 },
          phases: { warmupSeconds: 1, measurementSeconds: 1, cooldownSeconds: 1 },
          workload: {
            ...scenario.workload,
            load: { ...scenario.workload.load, concurrency: 2 },
            operations: [
              { id: "work", method: "GET", path: "/work", weight: 1, expectedStatus: [200] }
            ]
          }
        } as any,
        runId: "timeout-continuation",
        targetBaseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
        summaryPath: path.join(root, "summary.json"),
        shutdownFile: shutdown
      });
      assert.equal(
        fs.existsSync(shutdown),
        false,
        "a request timeout cannot impersonate external cancellation"
      );
      assert.equal(summary.shutdownReason, "phase-complete");
      assert.ok(Date.now() - began >= 750);
      assert.ok(summary.phaseResults.warmup.timeoutCount >= 1);
      assert.ok(summary.phaseResults.measurement.requests > 0);
      assert.ok(summary.phaseResults.cooldown.requests > 0);
      assert.ok(summary.requests.completed > 0);
      assert.equal(loadgenExitCode(summary), 20, "warmup timeout remains a failed final verdict");
      assert.ok(summary.errorSamples.some((e) => e.timeout && e.phase === "warmup"));
    } finally {
      if (prior === undefined) delete process.env.PARKBENCH_PHASE_SCALE;
      else process.env.PARKBENCH_PHASE_SCALE = prior;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test("external cancellation retains priority and timeout/threshold/normal exit codes remain explicit", () => {
  const input = {
    shutdownReason: "phase-complete",
    timeoutCount: 0,
    thresholdFailed: false,
    phaseResults: { warmup: { timeoutCount: 1 } }
  };
  assert.equal(loadgenExitCode(input), 20);
  assert.equal(loadgenExitCode({ ...input, shutdownReason: "cancelled" }), 10);
  assert.equal(loadgenExitCode({ ...input, phaseResults: {}, timeoutCount: 1 }), 20);
  assert.equal(loadgenExitCode({ ...input, phaseResults: {}, thresholdFailed: true }), 30);
  assert.equal(loadgenExitCode({ ...input, phaseResults: {} }), 0);
  assert.equal(loadgenExitCode({ ...input, phaseResults: {}, shutdownReason: "timeout" }), 20);
});
