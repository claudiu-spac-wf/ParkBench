import assert from "node:assert/strict";
import { it } from "node:test";
import { createMetricSelectionService } from "../../apps/control-plane/src/comparisons/metric-selection-service";
import { summaryHeader, summaryRow, summaryRun } from "../helpers/summary";
function setup() {
  const rows = new Map<string, any[]>(
    ["b", "v"].map((id) => {
      const row = summaryRow();
      row.statistics.average.value = id === "b" ? 100 : 120;
      return [id, [row]] as const;
    })
  );
  const headers = new Map(
    ["b", "v"].map((id) => {
      const h = summaryHeader(id);
      h.quality.complete = false;
      h.workload = {
        runId: id,
        requests: { completed: 200, errors: 3 },
        timeoutCount: 2,
        latencySeconds: { count: 0, p50: 0, p95: 0, p99: 0 }
      };
      return [id, h] as const;
    })
  );
  let token = "attempt-1";
  const reader: any = {
    read: (id: string) => ({ status: "READY", attemptToken: token, header: headers.get(id) }),
    page: (id: string, o: any = {}) => {
      const all = rows
        .get(id)!
        .filter((r) =>
          o.tablesOnly ? !!r.dimensions.table : o.nonTablesOnly ? !r.dimensions.table : true
        );
      const offset = Number(o.cursor ?? 0);
      const page = all.slice(offset, offset + (o.limit ?? 100));
      return {
        rows: page,
        hasMore: offset + page.length < all.length,
        nextCursor: String(offset + page.length)
      };
    },
    find: (id: string, k: string) => rows.get(id)!.find((r) => r.rowKey === k)
  };
  const project = createMetricSelectionService({
    reader,
    lookup: (id: string) =>
      ({ ...summaryRun(id), state: "FAILED", measurementValidity: "INCOMPLETE" }) as any
  });
  const selection: any = {
    id: "c",
    selectionRevision: 1,
    baselineRunId: "b",
    variantRunIds: ["v"],
    createdAt: "now"
  };
  const request: any = {
    contractVersion: "comparison-metric-selection.v1",
    selectionRevision: 1,
    runIds: ["v"],
    metrics: [{ metricId: "resource.database.memory.used", statistics: ["average"], selectors: {} }]
  };
  return {
    project,
    selection,
    request,
    headers,
    rows,
    reader,
    replace: () => (token = "attempt-2")
  };
}
it("projects partial retained values with numeric differences alongside failed/incomplete quality warnings", async () => {
  const f = setup();
  const r = await f.project(f.selection, f.request);
  assert.equal(r.rows[0].value, 120);
  assert.equal(r.rows[0].difference.percentageDifference, 20);
  assert.match(r.rows[0].warnings.join(" "), /Baseline measurements are incomplete/);
  assert.equal(r.rows[0].runState, "FAILED");
});
it("enforces membership/revision, explicit null and zero baseline arithmetic", async () => {
  const f = setup();
  await assert.rejects(
    f.project(f.selection, { ...f.request, runIds: ["foreign"] }),
    /not_selected/
  );
  await assert.rejects(f.project(f.selection, { ...f.request, selectionRevision: 2 }), /stale/);
  f.rows.get("b")![0].statistics.average.value = 0;
  assert.equal(
    (await f.project(f.selection, f.request)).rows[0].difference.percentageDifference,
    null
  );
  f.rows.get("v")![0].statistics.average.value = null;
  assert.equal((await f.project(f.selection, f.request)).rows[0].availability, "unavailable");
});
it("uses actual measurement duration and no-latency count rather than placeholder zeros", async () => {
  const f = setup();
  f.request.metrics = [
    { metricId: "workload.completed.rate", statistics: ["average"], selectors: {} },
    { metricId: "workload.latency.p50", statistics: ["value"], selectors: {} }
  ];
  const r = await f.project(f.selection, f.request);
  assert.equal(r.rows.find((x) => x.metricId === "workload.completed.rate")!.value, 20);
  assert.equal(r.rows.find((x) => x.metricId === "workload.latency.p50")!.value, null);
});
it("binds bounded cursors to published summary attempts, selection and windows", async () => {
  const f = setup();
  f.request.metrics[0].statistics = ["average", "p90", "p95"];
  f.request.limit = 1;
  const r = await f.project(f.selection, f.request);
  assert.equal(r.rows.length, 1);
  assert.ok(r.nextCursor);
  const next = await f.project(f.selection, { ...f.request, cursor: r.nextCursor });
  assert.equal(next.rows.length, 1);
  f.replace();
  await assert.rejects(
    f.project(f.selection, { ...f.request, cursor: r.nextCursor }),
    /cursor_stale/
  );
});
it("aborts projection without writing summaries", async () => {
  const f = setup();
  const c = new AbortController();
  c.abort();
  await assert.rejects(f.project(f.selection, f.request, { signal: c.signal }), /abort/i);
});

it("traverses 1200 table rows with bounded pages without lost/duplicate rows", async () => {
  const f = setup();
  f.rows.set(
    "v",
    Array.from({ length: 1200 }, (_, i) => summaryRow(`table-${String(i).padStart(4, "0")}`))
  );
  f.request.metrics = [
    { metricId: "database.db.table.read", statistics: ["total"], selectors: {} }
  ];
  f.request.limit = 37;
  const found = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await f.project(f.selection, { ...f.request, ...(cursor ? { cursor } : {}) });
    for (const row of page.rows) {
      assert.ok(!found.has(row.rowId));
      found.add(row.rowId);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(found.size, 1200);
});
it("returns native identities after the adapter reduction and historical absence as null", async () => {
  const f = setup();
  const { createMetricSelectionService } =
    await import("../../apps/control-plane/src/comparisons/metric-selection-service");
  const project = createMetricSelectionService({
    reader: f.reader,
    lookup: summaryRun,
    nativeProjection: async (run) =>
      run.id === "v"
        ? [
            {
              dimensions: { database: "db", latch_name: "same", latch_type: "MTX" },
              value: 30,
              reasons: [],
              sourceReferences: [{ instances: ["1", "2"], epochs: ["a", "b"] }]
            }
          ]
        : []
  });
  f.request.metrics = [
    { metricId: "native_latch.waits", statistics: ["total"], selectors: { latch_name: "same" } }
  ];
  const r = await project(f.selection, f.request);
  assert.equal(r.rows[0].value, 30);
  assert.equal(r.rows[0].baseline?.value, null);
  assert.equal(r.rows[0].difference.percentageDifference, null);
});

it("traverses workload cursors at run boundaries and detects concurrent publication", async () => {
  const f = setup();
  f.request.runIds = ["b", "v"];
  f.request.limit = 1;
  f.request.metrics = [{ metricId: "workload.errors", statistics: ["total"], selectors: {} }];
  const first = await f.project(f.selection, f.request);
  assert.equal(first.rows[0].runId, "b");
  const second = await f.project(f.selection, { ...f.request, cursor: first.nextCursor });
  assert.equal(second.rows[0].runId, "v");
  const original = f.reader.page;
  f.reader.page = (...args: any[]) => {
    const r = original(...args);
    f.replace();
    return r;
  };
  f.request.metrics = [
    { metricId: "resource.database.memory.used", statistics: ["average"], selectors: {} }
  ];
  await assert.rejects(f.project(f.selection, f.request), /source_changed/);
});

it("enforces scan and response budgets without returning partial successful pages", async () => {
  const f = setup();
  f.request.metrics = [
    { metricId: "database.db.table.read", statistics: ["total"], selectors: { table: "absent" } }
  ];
  f.rows.set(
    "v",
    Array.from({ length: 6500 }, (_, i) => summaryRow("table-" + i))
  );
  await assert.rejects(f.project(f.selection, f.request), /request_budget_exceeded/);
  f.request.metrics = [
    { metricId: "resource.database.memory.used", statistics: ["average"], selectors: {} }
  ];
  const row = summaryRow();
  row.sourceReferences = [{ metric: "memory", query: "x".repeat(3 * 1024 * 1024) }];
  f.rows.set("v", [row]);
  await assert.rejects(f.project(f.selection, f.request), /page_budget_exceeded/);
});

it("withholds percentages for mismatched units/dimensions and unstable summaries while retaining quality warnings", async () => {
  const f = setup();
  f.rows.get("b")![0].statistics.average.unit = "seconds";
  let result = await f.project(f.selection, f.request);
  assert.equal(result.rows[0].difference.percentageDifference, null);
  f.rows.get("b")![0].statistics.average.unit = "bytes";
  f.reader.find = () => ({ ...f.rows.get("b")![0], dimensions: { pool: "foreign" } });
  result = await f.project(f.selection, f.request);
  assert.equal(result.rows[0].difference.percentageDifference, null);
  const read = f.reader.read;
  f.reader.read = (id: string) => ({ ...read(id), attemptToken: undefined });
  result = await f.project(f.selection, f.request);
  assert.equal(result.rows[0].value, null);
  assert.match(result.rows[0].reasons.join(" "), /source_identity/);
  assert.ok(result.rows[0].warnings.length);
});

it("exposes a read-only bounded POST with typed errors and unchanged saved rows", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerComparisonRoutes } =
    await import("../../apps/control-plane/src/api/comparison-routes");
  const f = setup(),
    app = Fastify();
  const before = JSON.stringify([...f.rows]);
  registerComparisonRoutes(app, {
    controlUi: {
      getComparisonMetricValues: (id: string, r: any) => {
        if (id !== "c") throw new Error("comparison_not_found");
        return f.project(f.selection, r);
      }
    }
  } as any);
  try {
    const good = await app.inject({
      method: "POST",
      url: "/api/v1/comparisons/c/metric-values",
      payload: f.request
    });
    assert.equal(good.statusCode, 200);
    assert.equal(good.json().rows[0].difference.percentageDifference, 20);
    for (const change of [
      { runIds: ["foreign"] },
      { selectionRevision: 9 },
      { limit: 501 },
      { metrics: [{ metricId: "unknown", statistics: ["total"], selectors: {} }] }
    ]) {
      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/comparisons/c/metric-values",
        payload: { ...f.request, ...change }
      });
      assert.equal(bad.statusCode, 400);
    }
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/comparisons/foreign/metric-values",
          payload: f.request
        })
      ).statusCode,
      404
    );
    assert.equal(JSON.stringify([...f.rows]), before);
  } finally {
    await app.close();
  }
});

it("binds native page cursors to reduced acquisition/epoch identities", async () => {
  const f = setup();
  let value = 10;
  const project = createMetricSelectionService({
    reader: f.reader,
    lookup: summaryRun,
    nativeProjection: async () =>
      [1, 2].map((id) => ({
        dimensions: { database: "db", latch_name: String(id), latch_type: "MTX" },
        value,
        reasons: [],
        sourceReferences: [{ instances: [id], epochs: ["a"] }]
      }))
  });
  f.request.metrics = [{ metricId: "native_latch.waits", statistics: ["total"], selectors: {} }];
  f.request.limit = 1;
  const first = await project(f.selection, f.request);
  assert.ok(first.nextCursor);
  value = 20;
  await assert.rejects(
    project(f.selection, { ...f.request, cursor: first.nextCursor }),
    /cursor_stale/
  );
});
