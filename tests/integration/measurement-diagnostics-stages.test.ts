import test from "node:test";
import assert from "node:assert/strict";
import { ObserverCollector } from "../../packages/observers/src/collector";
import { HttpMetricsObserver } from "../../packages/observers/src/http-observer";
const base = {
  runId: "run-1",
  experimentId: "experiment-1",
  variantId: "v",
  repetition: 1,
  phase: "measurement"
};
function evidenceContext(events: any[]) {
  return {
    ...base,
    measurementEvidence: {
      diagnosticAttemptId: "a1",
      record: (event: any) => {
        const eventId = `event-${events.length}`;
        events.push({ ...event, eventId });
        return eventId;
      }
    }
  };
}
test("collector records infrastructure, dispatch and skipped slot ranges without inventing measurements", async () => {
  const now = Date.now,
    timer = globalThis.setTimeout;
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  (globalThis as any).setTimeout = (fn: () => void, delay = 0) => {
    clock += Number(delay);
    return timer(fn, 0);
  };
  const events: any[] = [],
    context = evidenceContext(events),
    starts: number[] = [];
  const collector = new ObserverCollector(
    [{ id: "core", kind: "core", required: true, samplingIntervalSeconds: 1 }],
    context,
    {
      create: () => ({
        id: "core",
        kind: "core",
        ready: async () => true,
        sample: async () => {
          starts.push(clock);
          clock += 1500;
          return [];
        }
      })
    }
  );
  try {
    const start = clock;
    const [result] = await collector.collectPhase(
      context,
      4,
      1,
      new Set(),
      () => false,
      { startMs: start, endMs: start + 4000 },
      async () => {}
    );
    assert.deepEqual(starts, [start, start + 1500, start + 3000]);
    assert.equal(result.observed, 0);
    assert.equal(result.expected, 4);
    assert.ok(events.some((e) => e.stage === "INFRASTRUCTURE" && e.outcome === "SUCCEEDED"));
    const skipped = events.filter((e) => e.stage === "SCHEDULE" && e.outcome === "SKIPPED");
    assert.deepEqual(
      skipped.map((e) => [e.skippedOrdinalStart, e.skippedOrdinalEnd]),
      [[2, 2]]
    );
    assert.ok(
      skipped.every(
        (e) =>
          typeof e.slotId === "string" &&
          JSON.parse(e.slotId)[2] === "measurement" &&
          JSON.parse(e.slotId)[5] === 1000
      )
    );
    const dispatch = events.filter(
      (e) => e.stage === "DISPATCH" && e.outcome === "STARTED" && !e.controllerAttempt
    );
    assert.equal(dispatch.length, 3);
    assert.ok(
      dispatch.every(
        (e) => JSON.parse(e.slotId)[1] === "a1" && JSON.parse(e.slotId)[2] === "measurement"
      )
    );
    assert.ok(events.every((e) => e.durationMs >= 0 && !("value" in e)));
  } finally {
    Date.now = now;
    globalThis.setTimeout = timer;
  }
});
test("HTTP retries retain parent controller/slot identity and parser timestamp provenance without retaining bodies", async () => {
  const originalFetch = globalThis.fetch;
  const events: any[] = [];
  let attempts = 0;
  const context: any = evidenceContext(events);
  context.measurementEvidence.slotId = "slot-1";
  context.measurementEvidence.parentEventId = "controller-1";
  context.measurementEvidence.controllerAttempt = 2;
  globalThis.fetch = (async () => {
    if (++attempts === 1) throw new Error("token=unsafe");
    return new Response(
      "# TYPE public_counter_total counter\npublic_counter_total 0\nexplicit_counter_total 0 1800000000000\n",
      { status: 200 }
    );
  }) as any;
  try {
    const observer = new HttpMetricsObserver("core", "core", "http://fixture", "/metrics", 100);
    const samples = await observer.sample(context);
    assert.equal(samples.length, 2);
    assert.ok(samples.every((s) => s.value === 0));
    const requests = events.filter((e) => e.stage === "HTTP" && e.outcome === "STARTED");
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((e) => e.httpAttempt),
      [1, 2]
    );
    assert.ok(
      requests.every(
        (e) =>
          e.controllerAttempt === 2 && e.slotId === "slot-1" && e.parentEventId === "controller-1"
      )
    );
    const parse = events.find((e) => e.stage === "PARSE" && e.outcome === "SUCCEEDED");
    assert.equal(parse.timestampOrigin, "UNKNOWN");
    assert.equal(parse.counts.parserTimestampSamples, 1);
    assert.equal(parse.counts.explicitTimestampSamples, 1);
    assert.equal(parse.sourceCapturedAtMs, null);
    assert.ok(!JSON.stringify(events).includes("unsafe"));
    assert.ok(events.every((e) => !("body" in e) && !("samples" in e)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("telemetry-only batches retain source counts and cannot imply individual measurement completeness", async () => {
  const events: any[] = [],
    context = evidenceContext(events),
    batches: any[] = [];
  const sample = {
    metricName: "parkbench_observer_health",
    type: "gauge" as const,
    labels: {
      experiment_id: "experiment-1",
      run_id: "run-1",
      variant_id: "v",
      repetition: "1",
      component: "observer",
      service: "core",
      phase: "measurement" as const
    },
    timestamp: Date.now() / 1000,
    value: 1,
    source: "fixture"
  };
  const collector = new ObserverCollector(
    [{ id: "core", kind: "core", required: true, samplingIntervalSeconds: 1 }],
    context,
    {
      create: () => ({
        id: "core",
        kind: "core",
        ready: async () => true,
        sample: async () => [sample]
      })
    },
    { append: (samples) => batches.push(samples) }
  );
  const [result] = await collector.collectPhase(context, 0);
  assert.equal(result.observed, 1); // Existing quality semantics stay unchanged during instrumentation.
  const filter = events.find((e) => e.stage === "PHASE_FILTER" && !e.sourceKey);
  assert.equal(filter.counts.validSamples, 1);
  assert.ok(events.some((e) => e.stage === "BUFFER_APPEND"));
  assert.ok(!events.some((e) => e.expectationId));
  assert.ok(batches.length > 0);
});

test("mixed-cadence off-schedule attempts do not manufacture slot identities", async () => {
  const now = Date.now,
    timer = globalThis.setTimeout;
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  (globalThis as any).setTimeout = (fn: () => void, delay = 0) => {
    clock += Number(delay);
    return timer(fn, 0);
  };
  const events: any[] = [],
    context = evidenceContext(events);
  const collector = new ObserverCollector(
    [
      { id: "fast", kind: "core", required: false, samplingIntervalSeconds: 1 },
      { id: "slow", kind: "core", required: false, samplingIntervalSeconds: 2 }
    ],
    context,
    { create: (d) => ({ id: d.id, kind: d.kind, ready: async () => true, sample: async () => [] }) }
  );
  try {
    await collector.collectPhase(context, 3, 1, new Set(), () => false, {
      startMs: clock,
      endMs: clock + 3000
    });
    const slow = events.filter(
      (e) =>
        e.stage === "DISPATCH" &&
        e.outcome === "STARTED" &&
        e.observerId === "slow" &&
        !e.controllerAttempt
    );
    assert.equal(slow.length, 3);
    assert.equal(slow.filter((e) => e.slotId).length, 2);
    assert.equal(slow[1].slotId, undefined);
  } finally {
    Date.now = now;
    globalThis.setTimeout = timer;
  }
});

test("native shared work has one generation and equal-valued fresh captures remain distinct", async () => {
  const { DatabaseObserverCollection } =
    await import("../../packages/observers/src/openedge-db/collection");
  const events: any[] = [];
  let finish!: (v: any) => void,
    reads = 0,
    clock = 1000;
  const collection = new DatabaseObserverCollection(
    async () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    10000,
    () => clock,
    (e: any) => events.push(e),
    (payload: any) => payload.collectedAt
  );
  const a = collection.metrics({ callerRole: "CONTROLLER", requestId: "request-1" }),
    b = collection.metrics({ callerRole: "UNKNOWN" });
  assert.equal(a, b);
  await Promise.resolve();
  finish({ value: 0, collectedAt: clock });
  await a;
  assert.equal(reads, 1);
  assert.ok(events.some((e) => e.outcome === "SHARED" && e.collectionGeneration === 1));
  clock += 5000;
  const c = collection.metrics({ callerRole: "UNKNOWN" });
  await Promise.resolve();
  finish({ value: 0, collectedAt: clock });
  await c;
  const captures = events.filter((e) => e.stage === "NATIVE_CAPTURE" && e.outcome === "SUCCEEDED");
  assert.deepEqual(
    captures.map((e) => e.collectionGeneration),
    [1, 2]
  );
  assert.deepEqual(
    captures.map((e) => e.sourceCapturedAtMs),
    [1000, 6000]
  );
  assert.ok(events.every((e) => !("value" in e) && !("payload" in e)));
  const cached = await collection.health();
  assert.equal(cached.value, 0);
  assert.equal(reads, 2);
  assert.ok(events.some((e) => e.reasonCodes?.includes("health_cache_hit")));
});

test("owned producer handoff freezes combined budgets and only mounts declared producer services", async () => {
  const { generateRunCompose } = await import("../../packages/compose-runner/src/run-compose");
  const { DIAGNOSTIC_DEFAULTS, freezeDiagnosticsConfig } =
    await import("../../packages/contracts/src/measurement-diagnostics");
  const scenario = (await import("../../examples/scenarios/crud-rest.json")).default;
  const frozen = freezeDiagnosticsConfig(undefined, DIAGNOSTIC_DEFAULTS, 1000);
  const producer = (component: string) => ({
    contractVersion: "measurement-diagnostics-producer.v1" as const,
    runId: "run-1",
    experimentId: "experiment-1",
    diagnosticAttemptId: "a1",
    runBudgetId: "budget-1",
    component,
    config: frozen,
    summaryBytes: 524288,
    traceBytes: 0,
    pendingLimitBytes: 262144
  });
  const mount = {
    directory: "/tmp/owned-fixture/run-1/measurement-diagnostics",
    producers: {
      "db-observer": producer("db-observer"),
      "pas-observer": producer("pas-observer"),
      "file-sampler": producer("file-sampler")
    }
  };
  const bundle = generateRunCompose(
    "run-1",
    "experiment-1",
    scenario as any,
    { db: "db:fixture", pas: "pas:fixture" },
    {
      loadgenImage: "loadgen:fixture",
      observerImage: "observer:fixture",
      measurementDiagnostics: mount
    }
  );
  const env = bundle.file
    .split("\n")
    .filter((line) => line.includes("PARKBENCH_MEASUREMENT_DIAGNOSTICS:"));
  assert.equal(env.length, 3);
  for (const line of env) {
    const config = JSON.parse(JSON.parse(line.slice(line.indexOf(":") + 1).trim()));
    assert.equal(config.config.summaryLimitBytes, frozen.summaryLimitBytes);
    assert.equal(config.runBudgetId, "budget-1");
  }
  assert.equal(
    bundle.file
      .split("\n")
      .filter((line) => line.includes(":/run/parkbench/measurement-diagnostics:rw")).length,
    3
  );
  assert.equal((bundle.file.match(/:rw"/g) ?? []).length >= 3, true);
  assert.ok(bundle.localPaths.includes(mount.directory));
  const excessive = structuredClone(mount);
  excessive.producers["db-observer"].pendingLimitBytes = DIAGNOSTIC_DEFAULTS.pendingLimitBytes;
  assert.throws(
    () =>
      generateRunCompose(
        "run-1",
        "experiment-1",
        scenario as any,
        { db: "db:fixture", pas: "pas:fixture" },
        {
          loadgenImage: "loadgen:fixture",
          observerImage: "observer:fixture",
          measurementDiagnostics: excessive
        }
      ),
    /combined_allocation/
  );
  const foreign = structuredClone(mount);
  foreign.producers["db-observer"].runId = "other";
  assert.throws(
    () =>
      generateRunCompose(
        "run-1",
        "experiment-1",
        scenario as any,
        { db: "db:fixture", pas: "pas:fixture" },
        {
          loadgenImage: "loadgen:fixture",
          observerImage: "observer:fixture",
          measurementDiagnostics: foreign
        }
      ),
    /owner/
  );
});

test("publication evidence counts latest-value replacement without equating render points to captures", async () => {
  const { PrometheusMetricBuffer } = await import("../../packages/metrics/src/prometheus-client");
  const events: any[] = [];
  const buffer = new PrometheusMetricBuffer((e: any) => events.push(e));
  const sample: any = {
    metricName: "public_counter_total",
    type: "counter",
    labels: { run_id: "run-1" },
    timestamp: 1,
    value: 0,
    source: "fixture"
  };
  buffer.append([sample]);
  buffer.append([{ ...sample, timestamp: 2 }]);
  const rendered = buffer.render();
  assert.equal(buffer.samples().length, 1);
  assert.match(rendered, / 0 2000/);
  assert.equal(
    events
      .filter((e) => e.stage === "BUFFER_APPEND")
      .reduce((n, e) => n + e.counts.overwrittenEntries, 0),
    1
  );
  const exposition = events.find((e) => e.stage === "EXPOSITION");
  assert.equal(exposition.counts.renderedSamples, 1);
  assert.ok(exposition.reasonCodes.includes("render_complete"));
  assert.ok(events.every((e) => !("value" in e) && !("samples" in e)));
  const failing = new PrometheusMetricBuffer(() => {
    throw new Error("diagnostic sink unavailable");
  });
  assert.doesNotThrow(() => {
    failing.append([sample]);
    failing.render();
  });
});

test("owned endpoint generation headers correlate shared captures and leave missing cross-process proof unknown", async () => {
  const fetch = globalThis.fetch,
    events: any[] = [],
    context = evidenceContext(events);
  const instance = "11111111-1111-1111-1111-111111111111";
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response("public_counter_total 0 1000\n", {
      headers:
        n === 4
          ? {}
          : {
              "x-parkbench-collection-id": `${instance}:${n < 3 ? 1 : 2}`,
              "x-parkbench-collection-generation": n < 3 ? "1" : "2",
              "x-parkbench-source-captured-at-ms": n < 3 ? "1000" : "6000"
            }
    });
  }) as any;
  try {
    const observer = new HttpMetricsObserver("db", "openedge_db_v1", "http://fixture");
    for (let i = 0; i < 4; i++) await observer.sample(context);
    const captures = events.filter((e) => e.stage === "NATIVE_CAPTURE");
    assert.deepEqual(
      captures.map((e) => e.outcome),
      ["SUCCEEDED", "SHARED", "SUCCEEDED", "UNCONFIRMED"]
    );
    assert.equal(captures[3].sourceCapturedAtMs, null);
    assert.deepEqual(
      captures.slice(0, 3).map((e) => e.collectionGeneration),
      [1, 1, 2]
    );
  } finally {
    globalThis.fetch = fetch;
  }
});

test("nested retries share one scheduled slot while retaining three controller and nine HTTP attempts", async () => {
  const fetch = globalThis.fetch,
    timer = globalThis.setTimeout;
  const events: any[] = [],
    context = evidenceContext(events);
  globalThis.fetch = (async () => {
    throw new Error("token=fixture-private");
  }) as any;
  (globalThis as any).setTimeout = (fn: () => void) => timer(fn, 0);
  try {
    const collector = new ObserverCollector(
      [{ id: "core", kind: "core", required: true, samplingIntervalSeconds: 5 }],
      context,
      { create: () => new HttpMetricsObserver("core", "core", "http://fixture") }
    );
    const [result] = await collector.collectPhase(context, 0);
    assert.equal(result.expected, 1);
    assert.equal(result.observed, 0);
    const attempts = events.filter((e) => e.stage === "HTTP" && e.outcome === "STARTED");
    assert.equal(attempts.length, 9);
    assert.deepEqual([...new Set(attempts.map((e) => e.controllerAttempt))], [1, 2, 3]);
    assert.equal(new Set(attempts.map((e) => e.slotId)).size, 1);
    assert.equal(new Set(attempts.map((e) => e.parentEventId)).size, 3);
    assert.ok(!JSON.stringify(events).includes("fixture-private"));
  } finally {
    globalThis.fetch = fetch;
    globalThis.setTimeout = timer;
  }
});
test("a stalled real HTTP body records timeout separately from successful headers without changing retry behavior", async (t) => {
  const http = await import("node:http");
  const server = http.createServer((_req, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("public_counter_total 0\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const events: any[] = [],
    context = evidenceContext(events),
    address = server.address() as any;
  const observer = new HttpMetricsObserver(
    "core",
    "core",
    `http://127.0.0.1:${address.port}`,
    "/metrics",
    100
  );
  await assert.rejects(() => observer.sample(context));
  assert.equal(events.filter((e) => e.stage === "HTTP" && e.outcome === "STARTED").length, 1);
  assert.ok(
    events.some(
      (e) =>
        e.stage === "HTTP" &&
        e.reasonCodes?.includes("headers_received") &&
        e.outcome === "SUCCEEDED"
    )
  );
  assert.ok(
    events.some(
      (e) =>
        e.stage === "HTTP" &&
        e.reasonCodes?.includes("body_read_failed") &&
        e.outcome === "TIMED_OUT" &&
        e.bodyReadMs > 0
    )
  );
  assert.ok(!events.some((e) => e.stage === "PARSE"));
});

test("native read timing distinguishes process output from normalization without changing values or retaining payloads", async (t) => {
  const fs = await import("node:fs/promises"),
    os = await import("node:os"),
    path = await import("node:path");
  const { namedLatchSnapshot } = await import("../helpers/openedge-db-v4");
  const { readOpenEdgeDbObserverPayload, parseOpenEdgeDbObserverOutput } =
    await import("../../packages/observers/src/openedge-db/adapter");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-native-stages-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const procedure = path.join(root, "public.cjs"),
    payload = namedLatchSnapshot();
  await fs.writeFile(
    procedure,
    `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(payload))}), 10);`
  );
  const events: any[] = [];
  const options: any = {
    executable: process.execPath,
    procedure,
    allowNonProcedure: true,
    onStage: (e: any) => events.push(e)
  };
  const result = await readOpenEdgeDbObserverPayload(options);
  assert.deepEqual(result, parseOpenEdgeDbObserverOutput(JSON.stringify(payload)));
  assert.deepEqual(
    events.map((e) => [e.stage, e.outcome]),
    [
      ["PROCESS", "SUCCEEDED"],
      ["NORMALIZE", "SUCCEEDED"]
    ]
  );
  assert.ok(events.every((e) => e.durationMs >= 0 && e.finishedAtMs >= e.startedAtMs));
  assert.equal(events[0].responseBytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.ok(!JSON.stringify(events).includes('"metrics"'));
  options.onStage = () => {
    throw new Error("sink failure");
  };
  assert.deepEqual(await readOpenEdgeDbObserverPayload(options), result);
  await fs.writeFile(procedure, "process.stdout.write('private-invalid-body');");
  options.onStage = (e: any) => events.push(e);
  await assert.rejects(() => readOpenEdgeDbObserverPayload(options), /contract_invalid:json/);
  assert.deepEqual(events.at(-1).stage, "NORMALIZE");
  assert.deepEqual(events.at(-1).outcome, "FAILED");
  assert.ok(!JSON.stringify(events).includes("private-invalid-body"));
});

test("native process timeout bounds a child that handles SIGTERM, so shutdown can seal its failure", async (t) => {
  const fs = await import("node:fs/promises"),
    os = await import("node:os"),
    path = await import("node:path");
  const { readOpenEdgeDbObserverPayload } =
    await import("../../packages/observers/src/openedge-db/adapter");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-native-deadline-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const procedure = path.join(root, "public.cjs"),
    events: any[] = [];
  // A finite fail-safe keeps the red test from leaking a deliberately uncooperative child.
  await fs.writeFile(
    procedure,
    "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),1800);"
  );
  const started = performance.now();
  await assert.rejects(
    readOpenEdgeDbObserverPayload({
      executable: process.execPath,
      procedure,
      allowNonProcedure: true,
      timeoutMs: 600,
      onStage: (e) => events.push(e)
    })
  );
  assert.ok(
    performance.now() - started < 1400,
    "native deadline must complete before the child's fail-safe exit"
  );
  assert.deepEqual(
    events.map((e) => [e.stage, e.outcome]),
    [["PROCESS", "FAILED"]]
  );
});
