import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { HttpPrometheusClient } from "../../packages/metrics/src/prometheus-client";

describe("Prometheus run target readiness", () => {
  it("waits for the requested run and phase labels on every required host/platform target", async () => {
    const queries: string[] = [];
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      queries.push(url.searchParams.get("query") ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "vector",
            result: ["node-exporter", "cadvisor"].map((service) => ({
              metric: { __name__: "up", run_id: "run-1", phase: "measurement", service },
              value: [Date.now() / 1000, "1"]
            }))
          }
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    try {
      await new HttpPrometheusClient(`http://127.0.0.1:${port}`).waitForRunTargets(
        "run-1",
        "measurement",
        ["node-exporter", "cadvisor"],
        1000
      );
      assert.equal(queries.length, 1);
      assert.equal(queries[0], 'up{run_id="run-1",phase="measurement"}');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out with the missing target service in a bounded diagnostic", async () => {
    const server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "vector",
            result: [
              {
                metric: { __name__: "up", run_id: "run-2", phase: "warmup", service: "node-exporter" },
                value: [Date.now() / 1000, "1"]
              }
            ]
          }
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    try {
      await assert.rejects(
        () =>
          new HttpPrometheusClient(`http://127.0.0.1:${port}`).waitForRunTargets(
            "run-2",
            "warmup",
            ["node-exporter", "cadvisor"],
            250
          ),
        /prometheus_run_targets_not_ready:run-2:warmup:cadvisor/
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
