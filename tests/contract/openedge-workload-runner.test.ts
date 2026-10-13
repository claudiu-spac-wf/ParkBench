import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  OPENEDGE_WORKLOAD_TIMEOUT_MS,
  boundedWorkError,
  parseWorkRequestBody,
  serializeWorkloadInput,
  validateCanonicalProcName
} from "../../packages/contracts/src";
import { buildSummary } from "../../apps/loadgen/src/summary";
import { LoadgenHttpClient } from "../../apps/loadgen/src/http-client";

describe("workload-runner-v1 contract", () => {
  it("uses one compact JSON value as the procedure input", () => {
    const request = parseWorkRequestBody(
      '{"procName":"Workloads/Read/mixed_table_large_reads.p","input":{"iterations":1,"rowsPerTable":100}}'
    );
    assert.equal(request.procName, "Workloads/Read/mixed_table_large_reads.p");
    assert.equal(serializeWorkloadInput(request.input), '{"iterations":1,"rowsPerTable":100}');
  });

  it("maps bounded failures without leaking the body or stack", () => {
    const error = boundedWorkError(new Error("workload_failed:/private/license/secret"), "req-1");
    assert.deepEqual(error, { ok: false, error: "workload_failed", requestId: "req-1" });
    assert.doesNotMatch(JSON.stringify(error), /private|license|secret/);
  });

  it("excludes lower-bound timeouts from completed latency", () => {
    const summary = buildSummary({
      runId: "run-timeout",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(60000).toISOString(),
      phaseDurationsSeconds: { warmup: 0, measurement: 1, cooldown: 0 },
      results: [
        {
          operation: "work",
          phase: "measurement",
          durationSeconds: OPENEDGE_WORKLOAD_TIMEOUT_MS / 1000,
          timeout: true,
          timeoutMs: OPENEDGE_WORKLOAD_TIMEOUT_MS,
          latencyObservation: "lower_bound",
          error: "workload_timeout"
        }
      ],
      shutdownReason: "timeout"
    });
    assert.equal(summary.requests.completed, 0);
    assert.equal(summary.timeoutCount, 1);
    assert.equal(summary.latencySeconds.count, 0);
    assert.equal(summary.shutdownReason, "timeout");
  });

  it("accepts only canonical workload paths", () => {
    assert.equal(validateCanonicalProcName("Workloads/Read/example.p"), "Workloads/Read/example.p");
  });

  it("turns a no-response request into a lower-bound timeout", async () => {
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.url === "/work") return;
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const result = await new LoadgenHttpClient(`http://127.0.0.1:${port}`, 25).execute(
        { id: "work", method: "POST", path: "/work", weight: 1 },
        { procName: "Workloads/Read/example.p", input: null }
      );
      assert.equal(result.timeout, true);
      assert.equal(result.error, "workload_timeout");
      assert.equal(result.latencyObservation, "lower_bound");
      assert.ok((result.timeoutMs ?? 0) >= 25);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
