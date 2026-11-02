#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { globalPlatformContext, templateDigest } from "./measurement-chart-scope.mjs";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  defaultRoot = path.join(repository, ".parkbench/validation/feature024");
const modes = new Set(["EVALUATION_GRID", "NATIVE_COUNTER_WINDOW", "SAVED_SUMMARY"]);
function assert(condition, reason) {
  if (!condition) throw new Error(`chart_capture_${reason}`);
}
function sameWindow(a, b) {
  return a.requestedStartMs === b.startMs && a.requestedEndMs === b.endMs;
}
export function validateChartCapture(record, expected) {
  assert(record?.contractVersion === "measurement-chart-capture.v1", "version");
  for (const key of [
    "runId",
    "dashboardUid",
    "panelId",
    "phase",
    "startMs",
    "endMs",
    "timezone",
    "origin"
  ])
    assert(record[key] === expected[key], "selection_mismatch");
  assert(record.complete === true, "incomplete");
  assert(Number.isSafeInteger(record.startMs) && record.endMs > record.startMs, "window");
  assert(
    typeof record.screenshot === "string" &&
      record.screenshot.endsWith(".png") &&
      typeof record.inspectorScreenshot === "string" &&
      record.inspectorScreenshot.endsWith(".png"),
    "screenshots_missing"
  );
  assert(
    record.viewport?.width > 0 &&
      record.viewport?.height > 0 &&
      record.viewport?.deviceScaleFactor > 0,
    "resolution"
  );
  assert(
    record.inspector?.executed === true &&
      record.inspector.startMs === expected.startMs &&
      record.inspector.endMs === expected.endMs,
    "inspector_missing"
  );
  assert(
    Array.isArray(record.queries) &&
      record.queries.length > 0 &&
      record.queries.length === record.inspector.queryCount,
    "queries_missing"
  );
  const refs = new Set();
  for (const query of record.queries) {
    assert(
      typeof query.refId === "string" &&
        !refs.has(query.refId) &&
        record.inspector.refIds.includes(query.refId),
      "query_identity"
    );
    refs.add(query.refId);
    assert(
      (query.kind === "INSTANT"
        ? query.stepMs === null
        : Number.isFinite(query.stepMs) && query.stepMs > 0) &&
        query.sourceEvidenceComplete === true &&
        typeof query.queryId === "string" &&
        modes.has(query.queryMode) &&
        sameWindow(
          query,
          query.kind === "INSTANT" ? { startMs: expected.endMs, endMs: expected.endMs } : expected
        ),
      "query_proof_missing"
    );
  }
  return record;
}
function endpoint(value) {
  const url = new URL(value);
  assert(
    ["http:", "https:"].includes(url.protocol) && !url.username && !url.password,
    "endpoint_invalid"
  );
  return url.origin;
}
async function boundedJson(response, max = 8 * 1024 ** 2) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= max, "response_limit");
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString());
  assert(
    response.ok,
    `query_failed_${response.status}_${/^[a-z_]{1,64}$/.test(parsed.errorType ?? "") ? parsed.errorType : "unknown"}`
  );
  return parsed;
}
function panelFrom(dashboard, id) {
  for (const panel of dashboard.panels ?? []) {
    if (String(panel.id) === String(id)) return panel;
    const nested = panelFrom(panel, id);
    if (nested) return nested;
  }
}
function requestBody(request, expected, refs) {
  try {
    if (!request.url().includes("/api/ds/query")) return;
    const body = request.postDataJSON();
    if (
      Number(body.from) !== expected.startMs ||
      Number(body.to) !== expected.endMs ||
      !Array.isArray(body.queries) ||
      body.queries.length > 64
    )
      return;
    const queries = body.queries.filter((q) => refs.has(q.refId));
    if (
      queries.length !== refs.size ||
      queries.some(
        (q) =>
          typeof q.expr !== "string" ||
          q.expr.length > 65536 ||
          !Number.isFinite(q.intervalMs) ||
          q.intervalMs <= 0
      )
    )
      return;
    return { body, queries };
  } catch {
    return;
  }
}
export function executedQuery(query, result) {
  const strings = [
    ...new Set(
      (result?.frames ?? [])
        .map((frame) => frame.schema?.meta?.executedQueryString)
        .filter((value) => typeof value === "string")
    )
  ];
  assert(strings.length === 1 && strings[0].length <= 65536, "executed_query_missing");
  const parsed = strings[0].match(/^Expr: ([\s\S]+)\nStep: ([^\n]+)\s*$/);
  assert(parsed, "executed_query_format");
  const expression = parsed[1].trim(),
    step = parsed[2].trim();
  assert(!/\$(?:__|[a-zA-Z_][a-zA-Z0-9_]*)/.test(expression), "executed_query_contains_macros");
  let offset = 0,
    stepMs = 0;
  for (const match of step.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
    assert(match.index === offset, "executed_step_invalid");
    offset += match[0].length;
    stepMs += Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  }
  assert(
    offset === step.length && (stepMs > 0 || query.instant === true) && Number.isFinite(stepMs),
    "executed_step_invalid"
  );
  return { expression, stepMs: query.instant === true ? null : stepMs };
}
// Matches the version pinned and checked below, independently of returned rows:
// https://github.com/grafana/grafana/blob/v12.1.1/pkg/promlib/models/query.go
// https://github.com/grafana/grafana/blob/v12.1.1/pkg/promlib/client/client.go
export function effectiveQueryWindow(query, execution, selection) {
  assert(!(query.instant && query.range), "mixed_query_kind_unsupported");
  if (query.instant) return { startMs: selection.endMs, endMs: selection.endMs };
  const offset = query.utcOffsetSec ?? 0;
  assert(
    Number.isSafeInteger(offset) && Math.abs(offset) <= 86400 && execution.stepMs > 0,
    "alignment_invalid"
  );
  const align = (value) =>
    Math.floor((value + offset * 1000) / execution.stepMs) * execution.stepMs - offset * 1000;
  return { startMs: align(selection.startMs), endMs: align(selection.endMs) };
}
export function renderedCounts(payload) {
  assert(Buffer.byteLength(JSON.stringify(payload)) <= 8 * 1024 ** 2, "response_limit");
  const counts = { zeroValues: 0, nullValues: 0, pointCount: 0, frameCount: 0 };
  for (const result of Object.values(payload.results ?? {})) {
    assert(!result.error, "grafana_query_failed");
    for (const frame of result.frames ?? []) {
      counts.frameCount++;
      const fields = frame.schema?.fields ?? [];
      for (let i = 0; i < fields.length; i++) {
        if (fields[i].type !== "number") continue;
        for (const value of frame.data?.values?.[i] ?? []) {
          assert(++counts.pointCount <= 500000, "point_limit");
          if (value === 0) counts.zeroValues++;
          if (value === null) counts.nullValues++;
        }
      }
    }
  }
  return counts;
}
async function containedOutput(root, expected) {
  const resolved = path.resolve(root);
  assert(
    resolved === defaultRoot || resolved.startsWith(defaultRoot + path.sep),
    "output_outside_root"
  );
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  assert((await fs.realpath(resolved)) === resolved, "output_symlink");
  for (const value of [expected.runId, expected.dashboardUid, String(expected.panelId)])
    assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value), "identity");
  const directory = path.join(
    resolved,
    `chart-${expected.runId}-${expected.panelId}-${randomUUID()}`
  );
  await fs.mkdir(directory, { mode: 0o700 });
  return directory;
}
/** Uses the deployed dashboard, rendered panel and actual query inspector request.
 * Query responses exist transiently for counting; no frame/sample arrays are saved. */
export async function captureMeasurementPanel(options) {
  const allowedSelection = [
    "runId",
    "dashboardUid",
    "panelId",
    "phase",
    "startMs",
    "endMs",
    "timezone",
    "origin"
  ];
  assert(
    options.selection &&
      Object.keys(options.selection).every((key) => allowedSelection.includes(key)),
    "selection_fields"
  );
  const expected = Object.fromEntries(allowedSelection.map((key) => [key, options.selection[key]]));
  expected.origin ??= "LIVE";
  expected.timezone ??= "UTC";
  expected.panelId = String(expected.panelId);
  assert(
    expected.origin === "LIVE" && expected.phase === "measurement" && expected.timezone === "UTC",
    "selection_invalid"
  );
  const grafana = endpoint(options.grafanaUrl ?? "http://127.0.0.1:13001"),
    control = endpoint(options.baseUrl ?? "http://127.0.0.1:13002"),
    directory = await containedOutput(
      options.outputRoot ?? path.join(defaultRoot, "charts"),
      expected
    );
  let browser, context;
  try {
    const health = await boundedJson(
      await fetch(grafana + "/api/health", { signal: AbortSignal.timeout(10000) })
    );
    assert(health.version === "12.1.1", "grafana_version_unverified");
    const dashboardResponse = await fetch(
        `${grafana}/api/dashboards/uid/${encodeURIComponent(expected.dashboardUid)}`,
        { signal: AbortSignal.timeout(10000) }
      ),
      dashboard = (await boundedJson(dashboardResponse)).dashboard,
      panel = panelFrom(dashboard, expected.panelId);
    assert(panel && panel.type !== "row", "panel_not_found");
    const targets = (panel.targets ?? []).filter((t) => !t.hide && t.expr),
      refs = new Set(targets.map((t) => t.refId));
    assert(refs.size > 0, "panel_has_no_queries");
    const variables = new Set((dashboard.templating?.list ?? []).map((v) => v.name)),
      url = new URL(`/d/${expected.dashboardUid}`, grafana);
    for (const [key, value] of Object.entries({
      viewPanel: expected.panelId,
      from: String(expected.startMs),
      to: String(expected.endMs),
      timezone: "UTC",
      refresh: ""
    }))
      url.searchParams.set(key, value);
    const runVariable = variables.has("run_id")
      ? "run_id"
      : variables.has("picker_run")
        ? "picker_run"
        : null;
    assert(runVariable, "run_selection_missing");
    url.searchParams.set(`var-${runVariable}`, expected.runId);
    if (variables.has("phase")) url.searchParams.set("var-phase", expected.phase);
    const { chromium } = await import("playwright");
    browser = options.browser ?? (await chromium.launch({ headless: true }));
    context = await browser.newContext({
      viewport: options.viewport ?? { width: 1440, height: 1000 },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();
    const initialResponse = page.waitForResponse(
      (r) =>
        r.url().startsWith(grafana + "/api/ds/query") &&
        Boolean(requestBody(r.request(), expected, refs)),
      { timeout: 45000 }
    );
    initialResponse.catch(() => {});
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
    const initial = await initialResponse;
    assert(initial.ok(), "initial_query_failed");
    const initialRequest = requestBody(initial.request(), expected, refs);
    assert(initialRequest, "initial_request_missing");
    const initialExecutions = new Map();
    {
      const payload = await initial.json();
      assert(Buffer.byteLength(JSON.stringify(payload)) <= 8 * 1024 ** 2, "response_limit");
      for (const query of initialRequest.queries)
        initialExecutions.set(query.refId, executedQuery(query, payload.results?.[query.refId]));
    }

    const region = page.getByRole("region", { name: panel.title, exact: true });
    await region.waitFor({ state: "visible", timeout: 30000 });
    await page.waitForTimeout(300);
    const screenshot = path.join(directory, "panel.png");
    await region.screenshot({ path: screenshot });
    url.searchParams.set("inspect", expected.panelId);
    url.searchParams.set("inspectTab", "query");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
    const dialog = page
      .getByRole("dialog")
      .filter({ hasText: `Inspect: ${panel.title}` })
      .first();
    await dialog.waitFor({ state: "visible", timeout: 30000 });
    const inspectorResponse = page.waitForResponse(
      (r) =>
        r.url().startsWith(grafana + "/api/ds/query") &&
        Boolean(requestBody(r.request(), expected, refs)),
      { timeout: 45000 }
    );
    inspectorResponse.catch(() => {});
    await dialog
      .getByRole("button", { name: "Panel inspector Query refresh button", exact: true })
      .click();
    const inspected = await inspectorResponse;
    assert(inspected.ok(), "inspector_query_failed");
    const actual = requestBody(inspected.request(), expected, refs);
    assert(actual, "inspector_request_missing");
    for (const query of actual.queries) {
      const original = initialRequest.queries.find((q) => q.refId === query.refId);
      assert(
        original?.expr === query.expr && original.intervalMs === query.intervalMs,
        "rendered_inspector_query_mismatch"
      );
    }
    const inspectorPayload = await inspected.json();
    assert(Buffer.byteLength(JSON.stringify(inspectorPayload)) <= 8 * 1024 ** 2, "response_limit");
    const executions = new Map();
    for (const query of actual.queries) {
      const execution = executedQuery(query, inspectorPayload.results?.[query.refId]),
        original = initialExecutions.get(query.refId);
      assert(
        original?.expression === execution.expression && original.stepMs === execution.stepMs,
        "rendered_executed_query_mismatch"
      );
      executions.set(query.refId, execution);
    }
    const rendered = renderedCounts(inspectorPayload),
      inspectorScreenshot = path.join(directory, "query-inspector.png");
    await dialog.screenshot({ path: inspectorScreenshot });
    const queries = [],
      reasonCodes = [];
    for (const query of actual.queries) {
      const execution = executions.get(query.refId),
        kind = query.instant ? "INSTANT" : "RANGE",
        effective = effectiveQueryWindow(query, execution, expected);
      assert((query.utcOffsetSec ?? 0) === 0, "timezone_offset_mismatch");
      const datasourceUid = query.datasource?.uid ?? panel.datasource?.uid;
      assert(["prometheus", "parkbench-runs"].includes(datasourceUid), "datasource_unsupported");
      const parameters = new URLSearchParams(
        kind === "INSTANT"
          ? { query: execution.expression, time: String(effective.endMs / 1000) }
          : {
              query: execution.expression,
              start: String(effective.startMs / 1000),
              end: String(effective.endMs / 1000),
              step: String(execution.stepMs / 1000)
            }
      );
      const queryUrl =
        (datasourceUid === "prometheus"
          ? grafana + "/api/datasources/proxy/uid/prometheus/api/v1/"
          : control + "/api/v1/grafana/prom/api/v1/") +
        (kind === "INSTANT" ? "query?" : "query_range?");
      const began = performance.now(),
        response = await fetch(queryUrl + parameters, { signal: AbortSignal.timeout(45000) }),
        rawHeader = response.headers.get("x-parkbench-query-evidence"),
        payload = await boundedJson(response);
      let metadata;
      if (datasourceUid === "prometheus") {
        assert(
          payload.status === "success" &&
            payload.data?.resultType === (kind === "INSTANT" ? "vector" : "matrix") &&
            Array.isArray(payload.data.result),
          "prometheus_response_invalid"
        );
        metadata = {
          contractVersion: "measurement-chart-query.v1",
          queryId: randomUUID(),
          runIds: [],
          mode: "unscoped",
          queryMode: "EVALUATION_GRID",
          requestedStartMs: effective.startMs,
          requestedEndMs: effective.endMs,
          stepMs: execution.stepMs,
          durationMs: performance.now() - began,
          seriesCount: payload.data.result.length,
          evaluationPointCount: payload.data.result.reduce(
            (n, row) => n + (row.values?.length ?? (row.value ? 1 : 0)),
            0
          ),
          decisions: [
            {
              stage: "UPSTREAM",
              outcome: "SUCCEEDED",
              requestedStartMs: effective.startMs,
              requestedEndMs: effective.endMs,
              effectiveStartMs: effective.startMs,
              effectiveEndMs: effective.endMs,
              stepMs: execution.stepMs,
              counts: { requestCount: 1 },
              reasonCodes: [
                "direct_prometheus_datasource",
                "evaluation_points_are_not_acquisitions",
                "generated_dashboard_template_reference"
              ],
              eventCount: 1
            }
          ],
          incomplete: false,
          droppedDecisionKinds: 0
        };
      } else {
        try {
          assert(rawHeader && rawHeader.length <= 8192, "source_query_evidence_missing");
          metadata = JSON.parse(Buffer.from(rawHeader, "base64url").toString());
          assert(
            metadata.contractVersion === "measurement-chart-query.v1" &&
              sameWindow(metadata, effective),
            "source_query_window_mismatch"
          );
        } catch {
          reasonCodes.push("source_query_evidence_missing");
        }
      }
      const target = targets.find((t) => t.refId === query.refId);
      assert(target, "query_template_missing");
      const globalContext =
        datasourceUid === "prometheus"
          ? globalPlatformContext({
              selection: expected,
              dashboardVersion: dashboard.version,
              target,
              expression: execution.expression,
              effective
            })
          : undefined;
      if (datasourceUid === "prometheus" && !globalContext)
        reasonCodes.push("global_source_context_missing");
      queries.push({
        refId: query.refId,
        kind,
        effectiveStartMs: effective.startMs,
        effectiveEndMs: effective.endMs,
        utcOffsetSec: query.utcOffsetSec ?? 0,
        datasourceUid,
        templateRef: `${expected.dashboardUid}:${dashboard.version}:${expected.panelId}:${query.refId}`,
        templateDigest: templateDigest(target.expr),
        stepMs: execution.stepMs,
        requestedStepMs: query.intervalMs,
        queryId: metadata?.queryId ?? null,
        queryMode: metadata?.queryMode ?? null,
        requestedStartMs: kind === "INSTANT" ? expected.endMs : expected.startMs,
        requestedEndMs: expected.endMs,
        sourceEvidenceComplete: Boolean(metadata && !metadata.incomplete),
        ...(globalContext ? { globalContext } : {}),
        ...(metadata ? { sourceMetadata: metadata } : {})
      });
    }
    const record = {
      contractVersion: "measurement-chart-capture.v1",
      ...expected,
      recordedAtMs: Date.now(),
      grafanaVersion: health.version,
      viewport: { ...page.viewportSize(), deviceScaleFactor: 1 },
      screenshot,
      inspectorScreenshot,
      inspector: {
        executed: true,
        startMs: Number(actual.body.from),
        endMs: Number(actual.body.to),
        queryCount: actual.queries.length,
        refIds: actual.queries.map((q) => q.refId)
      },
      queries,
      rendered,
      complete: queries.every(
        (q) => q.sourceEvidenceComplete && (q.datasourceUid !== "prometheus" || q.globalContext)
      ),
      reasonCodes
    };
    const file = path.join(directory, "capture.json"),
      handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { record, file };
  } catch (error) {
    const reasonCode = /^chart_capture_[a-zA-Z0-9_]+$/.test(error.message ?? "")
      ? error.message
      : "chart_capture_render_failed";
    try {
      const handle = await fs.open(path.join(directory, "failure.json"), "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            contractVersion: "measurement-chart-capture-failure.v1",
            ...expected,
            recordedAtMs: Date.now(),
            complete: false,
            reasonCodes: [reasonCode]
          }) + "\n"
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      /* A failed evidence sink cannot truthfully claim an artifact exists. */
    }
    throw error;
  } finally {
    await context?.close();
    if (!options.browser) await browser?.close();
  }
}
export async function capturePanelSelections(selections, capture, concurrency = 1) {
  assert(
    Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4,
    "concurrency_invalid"
  );
  assert(Array.isArray(selections) && selections.length <= 256, "panel_inventory_invalid");
  const results = [],
    failedSelections = [];
  for (let offset = 0; offset < selections.length; offset += concurrency) {
    const outcomes = await Promise.allSettled(
      selections
        .slice(offset, offset + concurrency)
        .map((selection) => Promise.resolve().then(() => capture(selection)))
    );
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "fulfilled") results.push(outcome.value);
      else
        failedSelections.push({
          selectionIndex: offset + index,
          reasonCode: /^chart_capture_[a-zA-Z0-9_]{1,80}$/.test(outcome.reason?.message ?? "")
            ? outcome.reason.message
            : "chart_capture_render_failed"
        });
    }
  }
  return { results, failedSelections };
}
export async function main(args = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(args[i]?.startsWith("--") && args[i + 1] !== undefined, "arguments_invalid");
    flags[args[i].slice(2)] = args[i + 1];
  }
  assert(flags.declaration, "declaration_required");
  const stat = await fs.lstat(flags.declaration);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 ** 2, "declaration_invalid");
  const declaration = JSON.parse(await fs.readFile(flags.declaration, "utf8"));
  assert(
    Array.isArray(declaration.panels) &&
      declaration.panels.length > 0 &&
      declaration.panels.length <= 256,
    "panel_inventory_invalid"
  );
  const concurrency = Number(flags.concurrency ?? 1);
  assert(
    Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4,
    "concurrency_invalid"
  );
  let batch;
  const { chromium } = await import("playwright"),
    browser = await chromium.launch({ headless: true });
  try {
    batch = await capturePanelSelections(
      declaration.panels,
      (selection) =>
        captureMeasurementPanel({
          selection,
          grafanaUrl: flags["grafana-url"],
          baseUrl: flags["base-url"],
          outputRoot: flags.output,
          browser
        }),
      concurrency
    );
  } finally {
    await browser.close();
  }
  return {
    complete: !batch.failedSelections.length && batch.results.every((r) => r.record.complete),
    failedSelections: batch.failedSelections,
    captures: batch.results.map((r) => ({
      file: r.file,
      runId: r.record.runId,
      dashboardUid: r.record.dashboardUid,
      panelId: r.record.panelId,
      complete: r.record.complete
    }))
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (!result.complete) process.exitCode = 2;
    })
    .catch((e) => {
      process.stderr.write(
        (e.message?.startsWith("chart_capture_") ? e.message : "chart_capture_failed") + "\n"
      );
      process.exitCode = 1;
    });
