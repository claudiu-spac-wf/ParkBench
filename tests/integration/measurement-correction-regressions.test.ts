import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observerLabels } from "../../packages/observers/src/adapter";
import { ObserverCollector } from "../../packages/observers/src/collector";
import { HttpMetricsObserver } from "../../packages/observers/src/http-observer";
import {
  createPlatform,
  httpObserverFactory,
  testObserverFactory
} from "../../apps/control-plane/src/platform";
import scenario from "../../examples/scenarios/crud-rest.json";

const context = {
  runId: "run",
  experimentId: "experiment",
  variantId: "baseline",
  repetition: 1,
  phase: "measurement"
};

test("a fresh late capture uses the still-active slot without changing timestamps, counts or the phase grid", async () => {
  const originalNow = Date.now,
    originalTimer = globalThis.setTimeout;
  const start = 1_800_000_000_000;
  let clock = start;
  Date.now = () => clock;
  (globalThis as any).setTimeout = (fn: () => void, delay = 0) => {
    clock += Number(delay);
    return originalTimer(fn, 0);
  };
  const actual: any[] = [],
    evidence: any[] = [];
  const c = {
    ...context,
    measurementEvidence: {
      diagnosticAttemptId: "attempt",
      record: (e: any) => {
        evidence.push(e);
        return `e-${evidence.length}`;
      }
    }
  };
  const collector = new ObserverCollector(
    [{ id: "source", kind: "core", required: true, samplingIntervalSeconds: 5 }],
    c,
    {
      create: () => ({
        id: "source",
        kind: "core",
        ready: async () => true,
        sample: async (ctx) => {
          const sample = {
            metricName: "fresh_reading",
            type: "gauge" as const,
            source: "fixture",
            value: actual.length,
            timestamp: clock / 1000,
            labels: observerLabels(ctx, "observer", "source")
          };
          actual.push(sample);
          if (actual.length === 1) clock += 5100;
          return [sample];
        }
      })
    }
  );
  try {
    const [quality] = await collector.collectPhase(c, 15, 1, new Set(), () => false, {
      startMs: start,
      endMs: start + 15000
    });
    // Independent oracle: three real source captures, including a late one in [5s,10s).
    assert.deepEqual(
      actual.map((s) => s.timestamp * 1000 - start),
      [0, 5100, 10000]
    );
    assert.deepEqual(
      actual.map((s) => s.value),
      [0, 1, 2]
    );
    assert.equal(quality.expected, 3);
    assert.equal(quality.observed, 3);
    const starts = evidence.filter(
      (e) => e.stage === "DISPATCH" && e.outcome === "STARTED" && !e.controllerAttempt
    );
    assert.deepEqual(
      starts.map((e) => e.scheduledAtMs - start),
      [0, 5000, 10000]
    );
    assert.equal(starts[1].startedAtMs - starts[1].scheduledAtMs, 100);
    assert.equal(
      evidence.filter((e) => e.stage === "SCHEDULE" && e.outcome === "SKIPPED").length,
      0
    );
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalTimer;
  }
});

test("fully elapsed slots remain missing and cancellation never backfills them", async () => {
  const originalNow = Date.now,
    originalTimer = globalThis.setTimeout;
  const start = 1_800_000_000_000;
  let clock = start,
    stop = false;
  Date.now = () => clock;
  (globalThis as any).setTimeout = (fn: () => void, delay = 0) => {
    clock += Number(delay);
    return originalTimer(fn, 0);
  };
  const captures: number[] = [],
    evidence: any[] = [];
  const c = {
    ...context,
    measurementEvidence: {
      diagnosticAttemptId: "attempt",
      record: (e: any) => {
        evidence.push(e);
        return `e-${evidence.length}`;
      }
    }
  };
  const collector = new ObserverCollector(
    [{ id: "source", kind: "core", required: true, samplingIntervalSeconds: 5 }],
    c,
    {
      create: () => ({
        id: "source",
        kind: "core",
        ready: async () => true,
        sample: async () => {
          captures.push(clock);
          clock += 12500;
          if (captures.length === 2) stop = true;
          return [];
        }
      })
    }
  );
  try {
    const [quality] = await collector.collectPhase(c, 30, 1, new Set(), () => stop, {
      startMs: start,
      endMs: start + 30000
    });
    assert.deepEqual(
      captures.map((t) => t - start),
      [0, 12500]
    );
    assert.equal(quality.expected, 6);
    assert.equal(quality.observed, 0);
    assert.deepEqual(
      evidence
        .filter((e) => e.stage === "SCHEDULE" && e.outcome === "SKIPPED")
        .map((e) => [e.skippedOrdinalStart, e.skippedOrdinalEnd]),
      [[1, 1]]
    );
    assert.ok(evidence.some((e) => e.stage === "SCHEDULE" && e.outcome === "CANCELLED"));
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalTimer;
  }
});

async function source(t: any, delayMs: number, body = "# TYPE measured gauge\nmeasured 17\n") {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(body);
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, requests: () => requests };
}

test("production native HTTP adapter permits a capture within the existing native five-second deadline plus normalization", async (t) => {
  const endpoint = await source(t, 5600);
  const observer = httpObserverFactory.create(
    {
      id: "native",
      kind: "openedge_db_v1",
      required: true,
      samplingIntervalSeconds: 5,
      configuration: { metricsUrl: endpoint.url }
    },
    context
  )!;
  const samples = await observer.sample(context);
  assert.equal(samples[0].value, 17);
  assert.equal(
    endpoint.requests(),
    1,
    "a supported slow capture must not cause retry amplification"
  );
});

test("native HTTP explicit deadlines still reject a source that exceeds the override", async (t) => {
  const endpoint = await source(t, 200);
  const observer = httpObserverFactory.create(
    {
      id: "native",
      kind: "openedge_db_v1",
      required: true,
      samplingIntervalSeconds: 5,
      configuration: { metricsUrl: endpoint.url, timeoutMs: 20 }
    },
    context
  )!;
  await assert.rejects(() => observer.sample(context), /timeout/i);
  assert.equal(endpoint.requests(), 3);
});

test("owned HTTP file acquisition is healthy without publishing a second path; external/local file sources retain their publisher", async (t) => {
  const endpoint = await source(
    t,
    0,
    "# TYPE parkbench_file_size_bytes gauge\nparkbench_file_size_bytes 42\n"
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-file-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: any, init: any) => {
    const url = new URL(String(input));
    return originalFetch(endpoint.url + url.pathname, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const [name, configuration, expectedPublished] of [
    ["owned", { path: root, metricsUrl: "http://file-sampler:9100" }, false],
    ["external", { path: root, metricsUrl: "http://external-file-source:9100" }, true],
    ["local", { path: root }, true]
  ] as const) {
    let acquisitions = 0;
    const fixtureFactory = testObserverFactory();
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: path.join(root, name),
        prometheusUrl: "http://unused",
        prometheusRetention: "7d",
        openedge: {}
      },
      {
        testMode: true,
        phaseScale: 0,
        observerFactory: {
          create: (declaration, ctx) => {
            if (declaration.kind !== "file_sampler_v1")
              return fixtureFactory.create(declaration, ctx);
            const actual =
              typeof declaration.configuration?.metricsUrl === "string"
                ? new HttpMetricsObserver(
                    declaration.id,
                    declaration.kind,
                    declaration.configuration.metricsUrl
                  )
                : httpObserverFactory.create(declaration, ctx)!;
            return {
              ...actual,
              id: actual.id,
              kind: actual.kind,
              ready: () => actual.ready(),
              sample: async (sampleContext) => {
                const samples = await actual.sample(sampleContext);
                assert.ok(samples.length);
                acquisitions++;
                return samples;
              }
            };
          }
        }
      }
    );
    try {
      await platform.startupRecovery;
      const candidate = structuredClone(scenario) as any;
      candidate.observers = [
        ...candidate.observers.filter((observer: any) => observer.kind === "openedge_db_v1"),
        {
          id: "files",
          kind: "file_sampler_v1",
          required: true,
          samplingIntervalSeconds: 5,
          configuration
        }
      ];
      const experiment = platform.coordinator.createExperiment(
        {
          scenario: { id: candidate.id, version: candidate.version },
          comparisonMode: "exploratory",
          repetitions: 1,
          variants: [{ id: "baseline", name: "Baseline", parameters: {} }],
          inputs: {
            databaseImage: "db:fixture",
            pasImage: "pas:fixture",
            seed: "input:seed/public",
            applicationArchive: "input:archive/public"
          }
        } as any,
        candidate
      );
      const discovered: any[] = [];
      const discovery = (platform.coordinator as any).options.targetDiscovery;
      const add = discovery.add.bind(discovery);
      discovery.add = (id: string, targets: any[]) => {
        discovered.push(...targets);
        return add(id, targets);
      };
      const run = await platform.coordinator.executeRun(
        platform.repositories.getRun(experiment.runIds[0])!
      );
      assert.equal(run.cleanupStatus, "COMPLETE");
      assert.deepEqual(
        discovered.find((target) => target.labels.service === "run-cadvisor").targets,
        ["cadvisor:8080"]
      );
      assert.ok(
        acquisitions >= 1,
        `${name} must actually acquire valid samples: ${JSON.stringify({
          state: run.state,
          code: run.failureCode,
          kind: run.failureKind,
          messages: platform.repositories
            .listEvents(run.id)
            .map((e: any) => e.message)
            .slice(-3)
        })}`
      );
      const metrics = platform.observerMetrics.render();
      const published = /parkbench_file_/;
      assert.equal(published.test(metrics), expectedPublished, name);
      assert.match(metrics, /parkbench_observer_observed_samples_total/);
    } finally {
      platform.close();
    }
  }
});

test("entering a phase late skips elapsed slots before dispatch and never creates two captures at the same instant", async () => {
  const originalNow = Date.now,
    originalTimer = globalThis.setTimeout;
  const start = 1_800_000_000_000;
  let clock = start + 12500;
  Date.now = () => clock;
  (globalThis as any).setTimeout = (fn: () => void, delay = 0) => {
    clock += Number(delay);
    return originalTimer(fn, 0);
  };
  const timestamps: number[] = [],
    events: any[] = [];
  const c = {
    ...context,
    measurementEvidence: {
      diagnosticAttemptId: "attempt",
      record: (e: any) => {
        events.push(e);
        return `e-${events.length}`;
      }
    }
  };
  const collector = new ObserverCollector(
    [{ id: "source", kind: "core", required: true, samplingIntervalSeconds: 5 }],
    c,
    {
      create: () => ({
        id: "source",
        kind: "core",
        ready: async () => true,
        sample: async (ctx) => {
          timestamps.push(clock);
          return [
            {
              metricName: "fresh",
              type: "gauge",
              value: 0,
              timestamp: clock / 1000,
              source: "fixture",
              labels: observerLabels(ctx, "observer", "source")
            }
          ];
        }
      })
    }
  );
  try {
    const [quality] = await collector.collectPhase(c, 30, 1, new Set(), () => false, {
      startMs: start,
      endMs: start + 30000
    });
    assert.deepEqual(
      timestamps.map((t) => t - start),
      [12500, 15000, 20000, 25000]
    );
    assert.equal(quality.expected, 6);
    assert.equal(quality.observed, 4);
    assert.deepEqual(
      events
        .filter((e) => e.stage === "SCHEDULE" && e.outcome === "SKIPPED")
        .map((e) => [e.skippedOrdinalStart, e.skippedOrdinalEnd]),
      [[0, 1]]
    );
    assert.deepEqual(
      events
        .filter((e) => e.stage === "DISPATCH" && e.outcome === "STARTED" && !e.controllerAttempt)
        .map((e) => e.scheduledAtMs - start),
      [10000, 15000, 20000, 25000]
    );
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalTimer;
  }
});

for (const infrastructureMs of [7000, 15000])
  test(`infrastructure work lasting ${infrastructureMs}ms cannot dispatch into an elapsed slot or closed phase`, async () => {
    const originalNow = Date.now,
      originalTimer = globalThis.setTimeout;
    const start = 1_800_000_000_000;
    let clock = start,
      checks = 0;
    Date.now = () => clock;
    (globalThis as any).setTimeout = (fn: () => void, delay = 0) => {
      clock += Number(delay);
      return originalTimer(fn, 0);
    };
    const times: number[] = [],
      events: any[] = [];
    const c = {
      ...context,
      measurementEvidence: {
        diagnosticAttemptId: "attempt",
        record: (e: any) => {
          events.push(e);
          return `e-${events.length}`;
        }
      }
    };
    const collector = new ObserverCollector(
      [{ id: "source", kind: "core", required: true, samplingIntervalSeconds: 5 }],
      c,
      {
        create: () => ({
          id: "source",
          kind: "core",
          ready: async () => true,
          sample: async (ctx) => {
            times.push(clock);
            return [
              {
                metricName: "fresh",
                type: "gauge",
                value: 0,
                timestamp: clock / 1000,
                source: "fixture",
                labels: observerLabels(ctx, "observer", "source")
              }
            ];
          }
        })
      }
    );
    try {
      const [quality] = await collector.collectPhase(
        c,
        15,
        1,
        new Set(),
        () => false,
        { startMs: start, endMs: start + 15000 },
        async () => {
          if (!checks++) clock += infrastructureMs;
        }
      );
      assert.deepEqual(
        times.map((t) => t - start),
        infrastructureMs === 7000 ? [7000, 10000] : []
      );
      assert.equal(quality.expected, 3);
      assert.equal(quality.observed, infrastructureMs === 7000 ? 2 : 0);
      assert.deepEqual(
        events
          .filter((e) => e.stage === "SCHEDULE" && e.outcome === "SKIPPED")
          .map((e) => [e.skippedOrdinalStart, e.skippedOrdinalEnd]),
        infrastructureMs === 7000 ? [[0, 0]] : [[0, 2]]
      );
    } finally {
      Date.now = originalNow;
      globalThis.setTimeout = originalTimer;
    }
  });
