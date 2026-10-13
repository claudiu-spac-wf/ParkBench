import assert from "node:assert/strict";
import { it } from "node:test";
import type { ComparisonResult } from "../../packages/contracts/src/comparison";
import { ComparisonResultLoader } from "../../apps/web/src/features/comparison/comparisonApi";

function baseline(changes: any = {}) {
  return {
    runId: "baseline",
    role: "BASELINE",
    state: "SUCCEEDED",
    measurementValidity: "VALID",
    summary: {
      status: "READY",
      attemptToken: "attempt-1",
      header: {
        generatedAt: "2026-10-02T12:00:00Z",
        metricDefinitionsVersion: "metrics.v1",
        quality: { complete: true }
      }
    },
    rows: [],
    ...changes
  };
}
function result(runs: any[], changes: any = {}): ComparisonResult {
  return {
    id: "comparison",
    selectionRevision: 4,
    baselineRunId: "baseline",
    runs,
    retryAfterSeconds: undefined,
    ...changes
  } as ComparisonResult;
}
const variant = { runId: "variant", role: "VARIANT", rows: [{ untouched: 123 }] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("accepts an on-page baseline from the same single response", async () => {
  const comparison = result([baseline(), variant]);
  const calls: any[] = [];
  const loader = new ComparisonResultLoader(async (id, options) => {
    calls.push([id, options]);
    return comparison;
  });
  const loaded = await loader.load("comparison");
  assert.deepEqual(calls, [["comparison", {}]]);
  assert.equal(loaded?.comparison, comparison);
  assert.equal(loaded?.baselineQuality.status, "accepted");
  assert.equal(loaded?.baselineQuality.run?.runId, "baseline");
  assert.equal(loaded?.baselineQuality.selectionRevision, 4);
});

it("brackets an off-page result with exactly two bounded first-page observations", async () => {
  const requested = result([variant]);
  const responses = [result([baseline()]), requested, result([baseline()])];
  const calls: any[] = [];
  const loader = new ComparisonResultLoader(async (id, options) => {
    calls.push([id, options]);
    return responses.shift()!;
  });
  const loaded = await loader.load("comparison", { cursor: "page-2", limit: 5 });
  assert.deepEqual(calls, [
    ["comparison", { limit: 1 }],
    ["comparison", { cursor: "page-2", limit: 5 }],
    ["comparison", { limit: 1 }]
  ]);
  assert.equal(loaded?.comparison, requested);
  assert.equal(loaded?.baselineQuality.status, "accepted");
  assert.equal(loaded?.baselineQuality.run?.summary.attemptToken, "attempt-1");
});

for (const changed of [
  { id: "different-comparison" },
  { selectionRevision: 5 },
  { baselineRunId: "different-baseline" }
]) {
  it(`withholds off-page quality when a bracket identity changes: ${Object.keys(changed)[0]}`, async () => {
    const requested = result([variant]);
    const responses = [result([baseline()]), requested, result([baseline()], changed)];
    const loader = new ComparisonResultLoader(async () => responses.shift()!);
    const loaded = await loader.load("comparison", { cursor: "page-2" });
    assert.equal(loaded?.comparison, requested);
    assert.equal(loaded?.baselineQuality.status, "unavailable");
    assert.match(loaded?.baselineQuality.reason ?? "", /changed|match/i);
  });
}

for (const [field, mutate] of Object.entries({
  state: (run: any) => {
    run.state = "FAILED";
  },
  validity: (run: any) => {
    run.measurementValidity = "INVALID";
  },
  status: (run: any) => {
    run.summary.status = "UNAVAILABLE";
  },
  attempt: (run: any) => {
    run.summary.attemptToken = "attempt-2";
  },
  generatedAt: (run: any) => {
    run.summary.header.generatedAt = "2026-10-02T12:01:00Z";
  },
  metricVersion: (run: any) => {
    run.summary.header.metricDefinitionsVersion = "metrics.v2";
  },
  complete: (run: any) => {
    run.summary.header.quality.complete = false;
  }
})) {
  it(`withholds stale baseline differences when ${field} changes across the bracket`, async () => {
    const after = baseline();
    mutate(after);
    const requested = result([variant]);
    const responses = [result([baseline()]), requested, result([after])];
    const loader = new ComparisonResultLoader(async () => responses.shift()!);
    const loaded = await loader.load("comparison", { cursor: "page-2" });
    assert.equal(loaded?.comparison, requested);
    assert.equal(loaded?.baselineQuality.status, "unavailable");
    if (["state", "validity", "complete"].includes(field)) {
      assert.equal(loaded?.baselineQuality.sourceStatus, "stable");
      assert.match(loaded?.baselineQuality.reason ?? "", /incomplete/i);
    } else {
      assert.equal(loaded?.baselineQuality.sourceStatus, "unavailable");
      assert.match(loaded?.baselineQuality.reason ?? "", /changed/i);
    }
  });
}

for (const [field, mutate] of Object.entries({
  attempt: (run: any) => {
    delete run.summary.attemptToken;
  },
  header: (run: any) => {
    delete run.summary.header;
  },
  complete: (run: any) => {
    delete run.summary.header.quality.complete;
  },
  generatedAt: (run: any) => {
    delete run.summary.header.generatedAt;
  },
  metricVersion: (run: any) => {
    delete run.summary.header.metricDefinitionsVersion;
  },
  state: (run: any) => {
    delete run.state;
  },
  validity: (run: any) => {
    delete run.measurementValidity;
  }
})) {
  it(`fails closed when READY baseline quality is missing ${field}`, async () => {
    const run = baseline();
    mutate(run);
    const loader = new ComparisonResultLoader(async () => result([run]));
    const loaded = await loader.load("comparison");
    assert.equal(loaded?.baselineQuality.status, "unavailable");
    assert.ok(loaded?.baselineQuality.reason);
  });
}

for (const failingCall of [0, 2]) {
  it(`keeps current-page values inspectable after baseline metadata read ${failingCall + 1} fails`, async () => {
    const requested = result([variant]);
    let calls = 0;
    const loader = new ComparisonResultLoader(async () => {
      const call = calls++;
      if (call === failingCall) throw new Error("metadata temporarily unavailable");
      return call === 1 ? requested : result([baseline()]);
    });
    const loaded = await loader.load("comparison", { cursor: "page-2" });
    assert.equal(calls, 3);
    assert.equal(loaded?.comparison, requested);
    assert.equal(loaded?.baselineQuality.status, "unavailable");
    assert.match(loaded?.baselineQuality.reason ?? "", /metadata temporarily unavailable/);
  });
}

it("polls an off-page RECOMPUTING baseline even when visible variants have no retry timer", async () => {
  const recomputing = baseline({ summary: { status: "RECOMPUTING", retryAfterSeconds: 3 } });
  const requested = result([variant]);
  const responses = [result([recomputing]), requested, result([structuredClone(recomputing)])];
  const loader = new ComparisonResultLoader(async () => responses.shift()!);
  const loaded = await loader.load("comparison", { cursor: "page-2" });
  assert.equal(loaded?.comparison, requested);
  assert.equal(loaded?.baselineQuality.status, "pending");
  assert.equal(loaded?.retryAfterSeconds, 3);
  assert.match(loaded?.baselineQuality.reason ?? "", /recomputing/i);
});

it("preserves a visible retry timer and refreshes the entire bracket on retry", async () => {
  const options: any[] = [];
  const loader = new ComparisonResultLoader(async (_id, option) => {
    options.push(option);
    return result(option.cursor ? [variant] : [baseline()], { retryAfterSeconds: 4 });
  });
  const first = await loader.load("comparison", { cursor: "page-2" });
  const second = await loader.load("comparison", { cursor: "page-2" });
  assert.equal(first?.retryAfterSeconds, 4);
  assert.equal(second?.retryAfterSeconds, 4);
  assert.equal(options.length, 6);
  assert.notEqual(first?.baselineQuality.generation, second?.baselineQuality.generation);
});

it("ignores a superseded result and stops dispatching its remaining bracket reads", async () => {
  const oldBefore = deferred<ComparisonResult>();
  let calls = 0;
  const loader = new ComparisonResultLoader(async (_id, options) => {
    calls++;
    if (calls === 1) return oldBefore.promise;
    return result([baseline(), { ...variant, runId: "current" }]);
  });
  const old = loader.load("comparison", { cursor: "old-page" });
  const current = await loader.load("comparison");
  oldBefore.resolve(result([baseline()]));
  assert.equal(await old, undefined);
  assert.equal(current?.comparison.runs[1].runId, "current");
  assert.equal(calls, 2);
});

it("ignores a late requested-page error after cancellation", async () => {
  const page = deferred<ComparisonResult>();
  const loader = new ComparisonResultLoader(async () => page.promise);
  const loading = loader.load("comparison");
  loader.cancel();
  page.reject(new Error("obsolete result failure"));
  assert.equal(await loading, undefined);
});

it("propagates a current requested-page failure instead of replacing it with metadata", async () => {
  let calls = 0;
  const loader = new ComparisonResultLoader(async () => {
    if (++calls === 2) throw new Error("requested page failed");
    return result([baseline()]);
  });
  await assert.rejects(loader.load("comparison", { cursor: "page-2" }), /requested page failed/);
  assert.equal(calls, 2);
});

it("accepts freshly created or restored results without requests and invalidates old generations", async () => {
  const old = deferred<ComparisonResult>();
  const loader = new ComparisonResultLoader(async () => old.promise);
  const loading = loader.load("old-comparison");
  const current = loader.accept(result([baseline(), variant]));
  assert.equal(current.baselineQuality.status, "accepted");
  old.resolve(result([baseline()]));
  assert.equal(await loading, undefined);
});

it("never fabricates absent baseline quality or applies a different baseline to saved results", async () => {
  const loader = new ComparisonResultLoader(async () => result([variant]));
  const missing = await loader.load("comparison");
  assert.equal(missing?.baselineQuality.status, "unavailable");
  assert.equal(missing?.baselineQuality.run, undefined);
  const none = loader.accept(result([variant], { baselineRunId: undefined }));
  assert.equal(none.baselineQuality.status, "unavailable");
  assert.equal(none.baselineQuality.baselineRunId, undefined);
});
