import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyReadinessProbeStatus } from "../../packages/compose-runner/src/orchestrator";
import { classifyRunError } from "../../apps/control-plane/src/runs/run-error";
import { DockerComposeOrchestrator } from "../../packages/compose-runner/src/orchestrator";
import http from "node:http";

for (const probe of ["health", "schema"]) {
  it(`${probe} readiness releases a stalled HTTP response body so cancellation can continue`, async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      // The native health handler may stall after the database exits.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const cleanup = new AbortController();
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const runner: any = new DockerComposeOrchestrator();
      runner.command = async (args: string[]) => {
        const output: unknown[] = [];
        const execute = new Function(
          "fetch",
          "console",
          `return (async () => { ${args.at(-1)} })();`
        );
        await execute(
          (_url: string, options?: RequestInit) =>
            fetch(`http://127.0.0.1:${address.port}`, {
              ...options,
              signal: AbortSignal.any(
                [options?.signal, cleanup.signal].filter(Boolean) as AbortSignal[]
              )
            }),
          { log: (value: unknown) => output.push(value) }
        );
        return { stdout: output.join("\n"), stderr: "" };
      };
      const bundle = { projectName: "stalled-readiness" };
      const result = await Promise.race([
        probe === "health"
          ? runner.probeFromObserver(bundle, "database", "/health")
          : runner.probeWorkloadSchema(bundle, 1),
        new Promise((_, reject) => {
          guard = setTimeout(() => reject(new Error("readiness probe remained blocked")), 7000);
        })
      ]);
      assert.equal(result, "retry");
    } finally {
      clearTimeout(guard);
      cleanup.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

describe("run readiness classification", () => {
  it("fails permanent client/container responses and retries transient or unavailable probes", () => {
    assert.equal(classifyReadinessProbeStatus(200), "ready");
    assert.equal(classifyReadinessProbeStatus(204), "ready");
    assert.equal(classifyReadinessProbeStatus(404), "failed");
    assert.equal(classifyReadinessProbeStatus(422), "failed");
    assert.equal(classifyReadinessProbeStatus(503), "retry");
    assert.equal(classifyReadinessProbeStatus(0), "retry");
  });

  it("maps runtime readiness failures and timeouts to the closed infrastructure codes", () => {
    const cases = [
      ["pas_readiness_failed:/health", "pas_readiness_failed"],
      ["database_readiness_failed:/health", "database_readiness_failed"],
      ["run_readiness_timeout:pas-2:/health", "pas_readiness_timeout"],
      ["run_readiness_timeout:database:/health", "database_readiness_timeout"]
    ] as const;
    for (const [message, code] of cases) {
      const classified = classifyRunError(new Error(message));
      assert.equal(classified?.failureKind, "infrastructure");
      assert.equal(classified?.failureCode, code);
      assert.ok((classified?.failureReason.length ?? 513) <= 512);
    }
  });
});
