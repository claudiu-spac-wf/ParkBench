import { describe, it } from "node:test";
import assert from "node:assert";
import { DataFactory, OperationSelector } from "../../apps/loadgen/src";
import scenario from "../../examples/scenarios/crud-rest.json";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSummary,
  LoadgenHttpClient,
  loadgenMetrics,
  OperationMetricAccumulator,
  metricSeriesKey,
  prometheusText,
  runLoadgen
} from "../../apps/loadgen/src";
import { runPhases } from "../../apps/control-plane/src/runs/phase-runner";
import { waitForPhaseClock } from "../../apps/loadgen/src/runner";
describe("load generator", () => {
  it("exposes the actual zero counters for every phase before traffic is released", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-phase-counters-"));
    const shutdown = path.join(root, "shutdown");
    const previousPort = process.env.PARKBENCH_METRICS_PORT;
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as any).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    process.env.PARKBENCH_METRICS_PORT = String(port);
    const running = runLoadgen({
      scenario: scenario as any,
      runId: "initial",
      targetBaseUrl: "http://127.0.0.1:1",
      workloadStartFile: path.join(root, "pending"),
      shutdownFile: shutdown,
      summaryPath: path.join(root, "summary.json")
    });
    try {
      let text = "";
      const deadline = Date.now() + 3000;
      while (!text && Date.now() < deadline) {
        try {
          text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      for (const phase of ["warmup", "measurement", "cooldown"]) {
        const line = text
          .split("\n")
          .find(
            (line) =>
              line.startsWith("parkbench_workload_requests_total{") &&
              line.includes(`phase="${phase}"`)
          );
        assert.ok(line, phase + ": counter exists before phase start");
        assert.equal(Number(line.split("} ")[1]?.split(" ")[0]), 0);
      }
    } finally {
      fs.writeFileSync(shutdown, "cancel");
      const summary = await running;
      assert.equal(summary.requests.completed, 0);
      if (previousPort === undefined) delete process.env.PARKBENCH_METRICS_PORT;
      else process.env.PARKBENCH_METRICS_PORT = previousPort;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not wait for another phase signal after a continuous schedule is released", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-continuous-loadgen-"));
    const file = path.join(temporary, "phase-clock.json");
    const originalClock = process.env.PARKBENCH_PHASE_CLOCK_PATH;
    const originalScale = process.env.PARKBENCH_PHASE_SCALE;
    const server = http.createServer((request, response) => {
      response.statusCode = request.url === "/health" ? 200 : request.method === "POST" ? 201 : 200;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      process.env.PARKBENCH_PHASE_CLOCK_PATH = file;
      process.env.PARKBENCH_PHASE_SCALE = "1";
      fs.writeFileSync(
        file,
        JSON.stringify({
          startedAt: new Date().toISOString(),
          phase: "measurement",
          continuous: true
        })
      );
      const summary = await runLoadgen({
        scenario: {
          ...scenario,
          phases: { warmupSeconds: 0, measurementSeconds: 1, cooldownSeconds: 1 }
        } as any,
        runId: "continuous",
        targetBaseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
        summaryPath: path.join(temporary, "summary.json")
      });
      assert.ok(summary.requests.completed > 0);
      assert.ok(summary.phases.measurement > 0);
      assert.ok(summary.phases.cooldown > 0);
    } finally {
      if (originalClock === undefined) delete process.env.PARKBENCH_PHASE_CLOCK_PATH;
      else process.env.PARKBENCH_PHASE_CLOCK_PATH = originalClock;
      if (originalScale === undefined) delete process.env.PARKBENCH_PHASE_SCALE;
      else process.env.PARKBENCH_PHASE_SCALE = originalScale;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it("waits for the coordinator's current phase before releasing workload traffic", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-phase-clock-"));
    try {
      const file = path.join(temporary, "phase-clock.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ startedAt: new Date().toISOString(), phase: "pending" })
      );
      let released = false;
      const waiting = waitForPhaseClock(file, "measurement").then((value) => {
        released = value;
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(released, false);
      fs.writeFileSync(
        file,
        JSON.stringify({ startedAt: new Date().toISOString(), phase: "warmup" })
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(released, false);
      fs.writeFileSync(
        file,
        JSON.stringify({ startedAt: new Date().toISOString(), phase: "measurement" })
      );
      await waiting;
      assert.equal(released, true);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it("exposes one current Prometheus series per label set", () => {
    const samples = [...loadgenSamples(1), ...loadgenSamples(2)];
    const current = new Map(samples.map((sample) => [metricSeriesKey(sample), sample]));
    const exposition = prometheusText([...current.values()]);
    assert.equal((exposition.match(/parkbench_workload_requests_total\{/g) ?? []).length, 1);
    assert.match(exposition, /# TYPE parkbench_workload_requests_total counter/);
  });

  it("emits finite latency buckets, count, sum, and phase-local throughput", () => {
    const samples = loadgenMetrics({
      labels: {
        experiment_id: "exp",
        run_id: "run",
        variant_id: "baseline",
        repetition: "1",
        component: "loadgen",
        service: "loadgen",
        phase: "measurement"
      },
      requests: 2,
      errors: 0,
      inFlight: 0,
      latencySeconds: 0.105,
      latencies: [0.01, 0.2],
      throughputPerSecond: 2,
      phase: "measurement",
      operation: "read"
    });
    const exposition = prometheusText(samples);
    assert.match(exposition, /request_duration_seconds_bucket\{[^}]*le="0\.01"/);
    assert.match(exposition, /request_duration_seconds_bucket\{[^}]*le="\+Inf"/);
    assert.match(exposition, /request_duration_seconds_count\{/);
    assert.match(exposition, /request_duration_seconds_sum\{/);
    assert.match(exposition, /# TYPE parkbench_workload_request_duration_seconds histogram/);
    assert.doesNotMatch(exposition, /# TYPE parkbench_workload_request_duration_second /);
    assert.equal(
      buildSummary({
        runId: "run",
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1000).toISOString(),
        phaseDurationsSeconds: { warmup: 0, measurement: 1, cooldown: 0 },
        results: [
          {
            operation: "read",
            durationSeconds: 0.1,
            phase: "measurement",
            error: "unexpected_status:500"
          }
        ],
        shutdownReason: "phase-complete"
      }).thresholdFailed,
      true
    );
  });

  it("updates operation histograms incrementally and excludes timeout lower bounds", () => {
    const accumulator = new OperationMetricAccumulator();
    accumulator.record({ operation: "read", durationSeconds: 0.01 });
    accumulator.record({ operation: "read", durationSeconds: 0.2, error: "unexpected_status:500" });
    accumulator.record({
      operation: "read",
      durationSeconds: 1,
      timeout: true,
      latencyObservation: "lower_bound",
      error: "workload_timeout"
    });
    const samples = loadgenMetrics({
      labels: {
        experiment_id: "exp",
        run_id: "run",
        variant_id: "baseline",
        repetition: "1",
        component: "loadgen",
        service: "loadgen",
        phase: "measurement"
      },
      ...accumulator.snapshot(),
      inFlight: 0,
      throughputPerSecond: 3,
      phase: "measurement",
      operation: "read"
    });
    const value = (metric: string, le?: string) =>
      samples.find(
        (sample) => sample.metricName === metric && (le === undefined || sample.labels.le === le)
      )?.value;
    assert.equal(value("parkbench_workload_requests_total"), 3);
    assert.equal(value("parkbench_workload_errors_total"), 2);
    assert.equal(value("parkbench_workload_timeouts_total"), 1);
    assert.equal(value("parkbench_workload_request_duration_seconds", "0.01"), 1);
    assert.equal(value("parkbench_workload_request_duration_seconds", "0.25"), 2);
    assert.equal(value("parkbench_workload_request_duration_seconds", "+Inf"), 2);
    assert.equal(value("parkbench_workload_request_duration_seconds_count"), 2);
    assert.ok(
      Math.abs(Number(value("parkbench_workload_request_duration_seconds_sum")) - 0.21) < 1e-9
    );
  });

  it("publishes completed requests during measurement and exits after cooldown", async () => {
    const server = http.createServer((request, response) => {
      response.statusCode = request.url === "/health" ? 200 : request.method === "POST" ? 201 : 200;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const targetPort = (server.address() as any).port;
    const portProbe = http.createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const metricsPort = (portProbe.address() as any).port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const previousScale = process.env.PARKBENCH_PHASE_SCALE;
    const previousMetricsPort = process.env.PARKBENCH_METRICS_PORT;
    process.env.PARKBENCH_PHASE_SCALE = "1";
    process.env.PARKBENCH_METRICS_PORT = String(metricsPort);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-loadgen-streaming-"));
    try {
      const running = runLoadgen({
        scenario: {
          ...scenario,
          phases: { warmupSeconds: 0, measurementSeconds: 2, cooldownSeconds: 1 },
          workload: { ...scenario.workload, load: { ...scenario.workload.load, concurrency: 1 } }
        } as any,
        runId: "run-streaming",
        targetBaseUrl: `http://127.0.0.1:${targetPort}`,
        summaryPath: path.join(root, "summary.json")
      });
      let sawMeasurementTraffic = false;
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && !sawMeasurementTraffic) {
        try {
          const metrics = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
          sawMeasurementTraffic = metrics
            .split("\n")
            .some(
              (line) =>
                line.startsWith("parkbench_workload_requests_total{") &&
                line.includes('phase="measurement"') &&
                Number(line.split("} ")[1]?.split(" ")[0]) > 0
            );
        } catch {
          /* Metrics server may still be starting. */
        }
        if (!sawMeasurementTraffic) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(sawMeasurementTraffic, true);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const summary = await Promise.race([
        running,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("loadgen_cooldown_timeout")), 7000);
        })
      ]).finally(() => clearTimeout(timeout));
      assert.equal(summary.shutdownReason, "phase-complete");
      assert.ok(summary.phaseResults.cooldown.requests > 0);
    } finally {
      if (previousScale === undefined) delete process.env.PARKBENCH_PHASE_SCALE;
      else process.env.PARKBENCH_PHASE_SCALE = previousScale;
      if (previousMetricsPort === undefined) delete process.env.PARKBENCH_METRICS_PORT;
      else process.env.PARKBENCH_METRICS_PORT = previousMetricsPort;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a no-response request as a lower-bound timeout", async () => {
    const server = http.createServer((request, response) => {
      if (request.method === "GET") {
        response.statusCode = 200;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(18911, "127.0.0.1", resolve));
    try {
      const client = new LoadgenHttpClient("http://127.0.0.1:18911", 25);
      const result = await client.execute(
        { id: "work", method: "POST", path: "/work", weight: 1, expectedStatus: [200] },
        { procName: "Workloads/Read/test.p", input: null }
      );
      assert.equal(result.timeout, true);
      assert.equal(result.latencyObservation, "lower_bound");
      assert.ok(result.durationSeconds >= 0.025);
      const summary = buildSummary({
        runId: "run-timeout",
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1000).toISOString(),
        phaseDurationsSeconds: { warmup: 0, measurement: 1, cooldown: 0 },
        results: [{ ...result, phase: "measurement" }],
        shutdownReason: "timeout"
      });
      assert.equal(summary.requests.completed, 0);
      assert.equal(summary.requests.errors, 1);
      assert.equal(summary.latencySeconds.count, 0);
      assert.equal(summary.timeoutCount, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("counts runner HTTP failures as errors and keeps timeout latency lower-bound", async () => {
    const server = http.createServer((request, response) => {
      response.statusCode = request.url === "/timeout" ? 408 : 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: false, error: "bounded" }));
    });
    await new Promise<void>((resolve) => server.listen(18912, "127.0.0.1", resolve));
    try {
      const client = new LoadgenHttpClient("http://127.0.0.1:18912", 1000);
      const failure = await client.execute(
        { id: "failure", method: "POST", path: "/failure", weight: 1, expectedStatus: [200] },
        { procName: "Workloads/Fixture/failure.p", input: null }
      );
      const timeout = await client.execute(
        { id: "timeout", method: "POST", path: "/timeout", weight: 1, expectedStatus: [200] },
        { procName: "Workloads/Fixture/cooperative-timeout.p", input: null }
      );
      const summary = buildSummary({
        runId: "run-http-errors",
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1000).toISOString(),
        phaseDurationsSeconds: { warmup: 0, measurement: 1, cooldown: 0 },
        results: [
          { ...failure, phase: "measurement" },
          { ...timeout, phase: "measurement" },
          { ...timeout, phase: "warmup" }
        ],
        shutdownReason: "timeout"
      });
      assert.equal(failure.error, "unexpected_status:500");
      assert.match(timeout.error ?? "", /^workload_timeout:.*bounded/);
      assert.equal(summary.requests.completed, 0);
      assert.equal(summary.requests.errors, 2);
      assert.equal(summary.applicationErrorCount, 1);
      assert.equal(summary.timeoutCount, 1);
      assert.equal(summary.latencySeconds.count, 1);
      assert.deepEqual(summary.phaseResults.warmup, {
        requests: 1,
        failures: 1,
        timeoutCount: 1
      });
      assert.match(summary.errorSamples[0].error, /bounded/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("is deterministic for the same seed", () => {
    const a = new DataFactory(42);
    const b = new DataFactory(42);
    assert.deepEqual(a.record(), b.record());
    assert.equal(
      new OperationSelector(scenario.workload.operations as any, () => 0).next().id,
      "read"
    );
  });

  it("lets the collector own phase duration without a second phase wait", async () => {
    const phases: string[] = [];
    const started = Date.now();
    await runPhases(
      { warmupSeconds: 1, measurementSeconds: 1, cooldownSeconds: 1 },
      async (phase) => {
        phases.push(phase);
      },
      1,
      false
    );
    assert.deepEqual(phases, ["warmup", "measurement", "cooldown"]);
    assert.ok(Date.now() - started < 500);
  });

  it("executes all phases with bounded constant concurrency and summarizes measurement only", async () => {
    const server = http.createServer((request: any, response: any) => {
      response.statusCode = request.url === "/health" ? 200 : request.method === "POST" ? 201 : 200;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(18910, "127.0.0.1", () => resolve()));
    const previousScale = process.env.PARKBENCH_PHASE_SCALE;
    process.env.PARKBENCH_PHASE_SCALE = "0";
    const output = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-loadgen-")),
      "summary.json"
    );
    try {
      const summary = await runLoadgen({
        scenario: {
          ...scenario,
          phases: { warmupSeconds: 0, measurementSeconds: 1, cooldownSeconds: 0 }
        } as any,
        runId: "run-loadgen",
        experimentId: "exp-loadgen",
        variantId: "baseline",
        repetition: 1,
        targetBaseUrl: "http://127.0.0.1:18910",
        summaryPath: output
      });
      assert.ok(summary.phases.warmup > 0);
      assert.ok(summary.phases.measurement > 0);
      assert.ok(summary.phases.cooldown > 0);
      assert.ok(summary.requests.completed >= 1);
      assert.equal(fs.existsSync(output), true);
    } finally {
      if (previousScale === undefined) delete process.env.PARKBENCH_PHASE_SCALE;
      else process.env.PARKBENCH_PHASE_SCALE = previousScale;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function loadgenSamples(requests: number) {
  return [
    {
      metricName: "parkbench_workload_requests_total",
      type: "counter" as const,
      labels: { run_id: "run", operation: "read" } as any,
      timestamp: requests,
      value: requests,
      source: "loadgen"
    }
  ];
}
