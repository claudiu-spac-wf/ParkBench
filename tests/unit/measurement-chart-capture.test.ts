import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

test("render metadata counts every index series beyond256frames while enforcing byte and point bounds", async () => {
  const { renderedCounts } = await import(
    path.resolve("scripts/diagnostics/capture-measurement-charts.mjs")
  );
  const frame = () => ({
    schema: { fields: [{ type: "number" }] },
    data: { values: [[0, null, 5]] }
  });
  const result = renderedCounts({ results: { A: { frames: Array.from({ length: 300 }, frame) } } });
  assert.deepEqual(result, { zeroValues: 300, nullValues: 300, pointCount: 900, frameCount: 300 });
  assert.throws(
    () => renderedCounts({ padding: "x".repeat(8 * 1024 ** 2), results: {} }),
    /chart_capture_response_limit/
  );
  assert.throws(
    () =>
      renderedCounts({
        results: {
          A: {
            frames: [
              {
                schema: { fields: [{ type: "number" }] },
                data: { values: [Array(500001).fill(0)] }
              }
            ]
          }
        }
      }),
    /chart_capture_point_limit/
  );
});

test("global platform context requires the generated template and every actual selector to retain the platform scope", async () => {
  const { generatedPanelQueries, globalPlatformContext, globalPlatformContextMatches } =
    await import(path.resolve("scripts/diagnostics/measurement-chart-scope.mjs"));
  const dashboard = JSON.parse(
    await fs.readFile("deploy/grafana/dashboards/Resources/platform-resources.json", "utf8")
  );
  const flat: any[] = [];
  const visit = (panels: any[]) => {
    for (const panel of panels) {
      flat.push(panel);
      visit(panel.panels ?? []);
    }
  };
  visit(dashboard.panels);
  for (const panelId of ["5", "6", "7", "13", "14", "15"]) {
    const panel = flat.find((p) => String(p.id) === panelId),
      target = panel.targets[0];
    const selection = {
      runId: "fresh",
      dashboardUid: dashboard.uid,
      panelId,
      phase: "measurement",
      startMs: 1000,
      endMs: 2000
    };
    const expression = target.expr
      .replaceAll("$__rate_interval", "20s")
      .replaceAll("$disk_exclude", "(loop|ram|zram|fd|sr|dm-|md).*");
    const effective = { startMs: 1000, endMs: 2000 };
    const context = globalPlatformContext({
      selection,
      dashboardVersion: 1,
      target,
      expression,
      effective
    });
    assert.ok(context);
    const queries = generatedPanelQueries(dashboard.uid, panelId);
    const q = {
      kind: "RANGE",
      refId: target.refId,
      datasourceUid: "prometheus",
      templateDigest: context.templateDigest,
      templateRef: `${dashboard.uid}:1:${panelId}:${target.refId}`,
      stepMs: 1000,
      effectiveStartMs: 1000,
      effectiveEndMs: 2000,
      globalContext: context,
      sourceMetadata: {
        contractVersion: "measurement-chart-query.v1",
        mode: "unscoped",
        queryMode: "EVALUATION_GRID",
        runIds: [],
        incomplete: false,
        requestedStartMs: 1000,
        requestedEndMs: 2000,
        stepMs: 1000,
        seriesCount: 1,
        evaluationPointCount: 2
      }
    };
    assert.equal(
      globalPlatformContextMatches(q, { dashboardUid: dashboard.uid, panelId, queries }, selection),
      true
    );
    assert.deepEqual(q.sourceMetadata.runIds, []);
    assert.equal(
      globalPlatformContext({
        selection,
        dashboardVersion: 1,
        target,
        expression: expression.replaceAll("parkbench-platform", "foreign-platform"),
        effective
      }),
      undefined
    );
    assert.equal(
      globalPlatformContext({
        selection,
        dashboardVersion: 1,
        target: { ...target, expr: target.expr + " + 1" },
        expression,
        effective
      }),
      undefined
    );
    assert.equal(
      globalPlatformContextMatches(
        { ...q, globalContext: { ...context, runId: "foreign" } },
        { dashboardUid: dashboard.uid, panelId, queries },
        selection
      ),
      false
    );
    assert.equal(
      globalPlatformContextMatches(q, { dashboardUid: "foreign", panelId, queries }, selection),
      false
    );
    const shifted = {
      ...q,
      effectiveStartMs: 0,
      effectiveEndMs: 1000,
      globalContext: { ...context, effectiveStartMs: 0, effectiveEndMs: 1000 },
      sourceMetadata: { ...q.sourceMetadata, requestedStartMs: 0, requestedEndMs: 1000 }
    };
    assert.equal(
      globalPlatformContextMatches(
        shifted,
        { dashboardUid: dashboard.uid, panelId, queries },
        selection
      ),
      false
    );
  }
});

test("preflight capture failures retain a bounded owned failure record before any browser context", async (t) => {
  const { captureMeasurementPanel } = await import(
    path.resolve("scripts/diagnostics/capture-measurement-charts.mjs")
  );
  const root = path.resolve(".parkbench/validation/feature024", "test-preflight-" + randomUUID());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ version: "unverified" }))
  );
  let contextRequested = false;
  await assert.rejects(
    () =>
      captureMeasurementPanel({
        selection: {
          runId: "preflight-run",
          dashboardUid: "affected",
          panelId: "1",
          phase: "measurement",
          startMs: 1000,
          endMs: 2000,
          timezone: "UTC",
          origin: "LIVE"
        },
        outputRoot: root,
        browser: {
          newContext: async () => {
            contextRequested = true;
            throw Error("must not open");
          }
        }
      }),
    /chart_capture_grafana_version_unverified/
  );
  assert.equal(contextRequested, false);
  const directories = await fs.readdir(root);
  assert.equal(directories.length, 1);
  const failure = JSON.parse(
    await fs.readFile(path.join(root, directories[0], "failure.json"), "utf8")
  );
  assert.equal(failure.runId, "preflight-run");
  assert.equal(failure.complete, false);
  assert.deepEqual(failure.reasonCodes, ["chart_capture_grafana_version_unverified"]);
});

test("panel capture batches bound concurrency, await every outcome and retain sanitized failures", async () => {
  const { capturePanelSelections } = await import(
    path.resolve("scripts/diagnostics/capture-measurement-charts.mjs")
  );
  for (const concurrency of [1, 2, 4]) {
    let active = 0,
      maximum = 0;
    const called: number[] = [];
    const result = await capturePanelSelections(
      [0, 1, 2, 3, 4, 5, 6],
      async (selection: number) => {
        called.push(selection);
        maximum = Math.max(maximum, ++active);
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (selection === 2) throw Error("private source or response body");
          return { selection };
        } finally {
          active--;
        }
      },
      concurrency
    );
    assert.equal(active, 0);
    assert.equal(maximum, concurrency);
    assert.deepEqual(called, [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(
      result.results,
      [0, 1, 3, 4, 5, 6].map((selection) => ({ selection }))
    );
    assert.deepEqual(result.failedSelections, [
      { selectionIndex: 2, reasonCode: "chart_capture_render_failed" }
    ]);
    assert.ok(!JSON.stringify(result).includes("private source"));
  }
  for (const concurrency of [0, 5, 1.5, NaN, Infinity])
    await assert.rejects(
      () =>
        capturePanelSelections(
          [0],
          () => {
            throw Error("must not dispatch");
          },
          concurrency
        ),
      /chart_capture_concurrency_invalid/
    );
});
test("capture uses Grafana's executed expression and step, including backend macro expansion", async () => {
  const { executedQuery } = await import(
    path.resolve("scripts/diagnostics/capture-measurement-charts.mjs")
  );
  const query = { refId: "A", expr: "rate(public_metric[$__rate_interval])", intervalMs: 5000 };
  assert.deepEqual(
    executedQuery(query, {
      frames: [
        { schema: { meta: { executedQueryString: "Expr: rate(public_metric[20s])\nStep: 5s" } } }
      ]
    }),
    { expression: "rate(public_metric[20s])", stepMs: 5000 }
  );
  assert.throws(() => executedQuery(query, { frames: [] }));
  assert.throws(() =>
    executedQuery(query, {
      frames: [
        {
          schema: {
            meta: { executedQueryString: "Expr: rate(public_metric[$__rate_interval])\nStep: 5s" }
          }
        }
      ]
    })
  );
  assert.throws(() =>
    executedQuery(query, {
      frames: [{ schema: { meta: { executedQueryString: "Expr: public_metric\nStep: unknown" } } }]
    })
  );
});
test("instant panels retain an instant evaluation time and never invent a sampling grid", async () => {
  const { executedQuery, validateChartCapture } = await import(
    path.resolve("scripts/diagnostics/capture-measurement-charts.mjs")
  );
  assert.deepEqual(
    executedQuery(
      { refId: "A", instant: true, range: false },
      { frames: [{ schema: { meta: { executedQueryString: "Expr: public_total\nStep: 0s" } } }] }
    ),
    { expression: "public_total", stepMs: null }
  );
  const selection = {
    runId: "run-1",
    dashboardUid: "summary",
    panelId: "14",
    phase: "measurement",
    startMs: 1000,
    endMs: 11000,
    timezone: "UTC",
    origin: "LIVE"
  };
  const record = {
    contractVersion: "measurement-chart-capture.v1",
    ...selection,
    complete: true,
    screenshot: "panel.png",
    inspectorScreenshot: "inspector.png",
    viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
    inspector: { executed: true, startMs: 1000, endMs: 11000, queryCount: 1, refIds: ["A"] },
    queries: [
      {
        refId: "A",
        kind: "INSTANT",
        stepMs: null,
        queryId: "q1",
        queryMode: "SAVED_SUMMARY",
        requestedStartMs: 11000,
        requestedEndMs: 11000,
        sourceEvidenceComplete: true
      }
    ]
  };
  assert.doesNotThrow(() => validateChartCapture(record, selection));
  assert.throws(() =>
    validateChartCapture(
      { ...record, queries: [{ ...record.queries[0], kind: "RANGE" }] },
      selection
    )
  );
});
test("effective windows follow the deployed Grafana backend alignment without deriving membership or time from returned samples", async () => {
  const { effectiveQueryWindow } = await import(
    path.resolve("scripts/diagnostics/capture-measurement-charts.mjs")
  );
  const selection = { startMs: 1793362040204, endMs: 1793362220204 };
  assert.deepEqual(
    effectiveQueryWindow(
      { range: true, instant: false, utcOffsetSec: 0 },
      { stepMs: 15000 },
      selection
    ),
    { startMs: 1793362035000, endMs: 1793362215000 }
  );
  assert.deepEqual(
    effectiveQueryWindow({ instant: true, range: false }, { stepMs: null }, selection),
    { startMs: selection.endMs, endMs: selection.endMs }
  );
  assert.throws(() =>
    effectiveQueryWindow({ instant: true, range: true }, { stepMs: 5000 }, selection)
  );
});
