import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildComparison,
  comparisonSelectionPage,
  comparisonTablePage,
  normalizeComparisonSelection,
  COMPARISON_RESPONSE_BYTES
} from "../../apps/control-plane/src/comparisons/service";
import { SummaryReader, ComparisonSelection } from "../../packages/contracts/src/comparison";
import { summaryRun, summaryHeader, summaryRow } from "../helpers/summary";
function fixtureReader(names: Record<string, string[]>): SummaryReader {
  const rows = Object.fromEntries(
    Object.entries(names).map(([id, names]) => [id, names.sort().map((n) => summaryRow(n))])
  );
  return {
    read: (id) => ({ status: "READY", attemptToken: id + "-token", header: summaryHeader(id) }),
    page: (id, o = {}) => {
      const offset = o.cursor ? Number(o.cursor) : 0,
        items = rows[id] ?? [],
        slice = items.slice(offset, offset + (o.limit ?? 100)),
        hasMore = offset + slice.length < items.length;
      return {
        rows: slice,
        hasMore,
        nextCursor: hasMore ? String(offset + slice.length) : undefined,
        totalRowCount: items.length,
        returnedRowCount: slice.length
      };
    },
    find: (id, key) => (rows[id] ?? []).find((r) => r.rowKey === key),
    iterate: async function* (id) {
      yield* rows[id] ?? [];
    },
    tableUnionCount: (a, b) =>
      new Set([...(rows[a] ?? []), ...(rows[b ?? ""] ?? [])].map((r) => r.rowKey)).size
  };
}
const selection: ComparisonSelection = {
  id: "c",
  baselineRunId: "b",
  variantRunIds: ["v"],
  selectionRevision: 1,
  createdAt: "now"
};
describe("bounded comparison selection/run/table pages", () => {
  it("preserves a selection larger than 8 MiB while bounding every metadata response", () => {
    const ids = Array.from({ length: 35000 }, (_, i) => String(i).padStart(250, "x")),
      selected = normalizeComparisonSelection({ ...selection, variantRunIds: ids });
    assert.ok(Buffer.byteLength(JSON.stringify(ids)) > COMPARISON_RESPONSE_BYTES);
    const reader = { ...fixtureReader({}), read: () => ({ status: "RECOMPUTING" as const }) };
    const result = buildComparison(selected, reader, (id) => summaryRun(id));
    assert.equal(result.selectionPage.runIds.length, 100);
    assert.equal(result.runs.length, 5);
    assert.equal(result.totalSelectedRunCount, 35001);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < COMPARISON_RESPONSE_BYTES);
    let cursor: string | undefined,
      count = 0;
    do {
      const page = comparisonSelectionPage(selected, { cursor, limit: 500 });
      count += page.runIds.length;
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(count, 35001);
  });
  it("binds selection cursors to comparison identity and revision while polling leaves revision stable", () => {
    const page = comparisonSelectionPage(selection, { limit: 1 });
    assert.deepEqual(page.runIds, ["b"]);
    assert.deepEqual(comparisonSelectionPage(selection, { cursor: page.nextCursor }).runIds, ["v"]);
    assert.throws(
      () => comparisonSelectionPage({ ...selection, id: "foreign" }, { cursor: page.nextCursor }),
      /cursor_invalid/
    );
    assert.throws(
      () =>
        comparisonSelectionPage(
          { ...selection, selectionRevision: 2 },
          { cursor: page.nextCursor }
        ),
      /cursor_stale/
    );
    assert.throws(() => comparisonSelectionPage(selection, { limit: 501 }), /page_limit_invalid/);
  });
  it("uses five run headers by default, enforces 25 maximum and traverses exact order", () => {
    const selected = { ...selection, variantRunIds: Array.from({ length: 29 }, (_, i) => "v" + i) },
      reader = fixtureReader({});
    const first = buildComparison(selected, reader, (id) => summaryRun(id));
    assert.equal(first.runs.length, 5);
    const rest = buildComparison(selected, reader, (id) => summaryRun(id), {
      cursor: first.page.nextCursor,
      limit: 25
    });
    assert.equal(rest.runs.length, 25);
    assert.equal(rest.page.hasMore, false);
    assert.throws(
      () => buildComparison(selected, reader, (id) => summaryRun(id), { limit: 26 }),
      /page_limit_invalid/
    );
  });
  it("merges every variant/baseline key, including baseline-only rows, with no activity ranking", () => {
    const reader = fixtureReader({ b: ["A", "BaselineOnly", "C"], v: ["A", "C", "VariantOnly"] });
    let cursor: string | undefined;
    const names: string[] = [];
    do {
      const page = comparisonTablePage(selection, "v", reader, { cursor, limit: 2 });
      names.push(...page.rows.map((r) => r.row.dimensions.table));
      assert.equal(page.totalRowCount, 4);
      assert.ok(page.rows.length <= 2);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(names, ["A", "BaselineOnly", "C", "VariantOnly"]);
    const page = comparisonTablePage(selection, "v", reader, { limit: 500 });
    const missing = page.rows.find((r) => r.row.dimensions.table === "BaselineOnly")!;
    assert.equal(missing.row.statistics.average?.value, null);
    assert.equal(missing.baselineRow?.statistics.average?.value, 1);
  });
  it("binds table cursors to both published versions/attempts, selection, and run ownership", () => {
    const reader = fixtureReader({ b: ["A", "B"], v: ["A", "B"] }),
      page = comparisonTablePage(selection, "v", reader, { limit: 1 });
    const oldRead = reader.read;
    reader.read = (id) => ({
      ...oldRead(id),
      attemptToken: id === "b" ? "new-token" : oldRead(id).attemptToken
    });
    assert.throws(
      () => comparisonTablePage(selection, "v", reader, { cursor: page.nextCursor }),
      /comparison_table_cursor_stale/
    );
    assert.throws(
      () => comparisonTablePage(selection, "unselected", reader),
      /comparison_run_not_selected/
    );
    assert.throws(
      () =>
        comparisonTablePage({ ...selection, selectionRevision: 2 }, "v", reader, {
          cursor: page.nextCursor
        }),
      /comparison_table_cursor_stale/
    );
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
it("HTTP accepts the complete selection above 8 MiB, bounds read/pending pages and exports every selected ID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "large-selection-http-")),
    platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: root,
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    ),
    app = buildServer(platform);
  try {
    await platform.startupRecovery;
    platform.summaryWorker.stop();
    const ids = Array.from({ length: 35000 }, (_, i) => String(i).padStart(250, "x"));
    platform.repositories.saveExperiment({
      id: "exp-test",
      status: "QUEUED",
      runIds: [],
      createdAt: "now",
      scenario: { id: "fixture", version: "1" },
      comparisonMode: "exploratory",
      repetitions: 1,
      variants: [],
      inputs: {
        databaseImage: "fixture",
        pasImage: "fixture",
        seed: "fixture",
        applicationArchive: "fixture"
      }
    });
    platform.controlRepository.saveExperiment({
      experimentId: "exp-test",
      previewId: "preview",
      request: { runName: "fixture" },
      scenarioSnapshot: { id: "fixture", version: "1" },
      matrixSpec: {},
      executionPolicy: {},
      queueOrdinal: 1,
      status: "QUEUED",
      createdAt: "now"
    });
    platform.repositories.client.db.exec("BEGIN");
    for (const id of ids)
      platform.repositories.saveRun({ ...summaryRun(id), variantId: id, state: "QUEUED" });
    platform.repositories.client.db.exec("COMMIT");
    const payload = { experimentId: "exp-test", baselineRunId: ids[0], variantRunIds: ids };
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) > COMPARISON_RESPONSE_BYTES);
    const posted = await app.inject({ method: "POST", url: "/api/v1/comparisons", payload });
    assert.equal(posted.statusCode, 201, posted.body);
    assert.ok(Buffer.byteLength(posted.body) < COMPARISON_RESPONSE_BYTES);
    const created = posted.json();
    assert.equal(created.totalSelectedRunCount, ids.length);
    assert.equal(created.runs.length, 5);
    const base = `/api/v1/comparisons/${created.id}`;
    let cursor: string | undefined;
    const seen: string[] = [];
    do {
      const response = await app.inject({
        method: "GET",
        url: `${base}/selection?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      });
      assert.equal(response.statusCode, 200);
      assert.ok(Buffer.byteLength(response.body) < COMPARISON_RESPONSE_BYTES);
      const page = response.json().selectionPage;
      seen.push(...page.runIds);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, ids);
    assert.equal(
      (await app.inject({ method: "GET", url: `${base}/runs/${ids[1]}/tables` })).statusCode,
      200
    );
    assert.equal(
      (await app.inject({ method: "GET", url: `${base}/runs/unselected/tables` })).statusCode,
      400
    );
    const token = platform.repositories.claimSummaryAttempt(ids[0]);
    assert.ok(token);
    const pending = await app.inject({ method: "GET", url: `${base}/export` });
    assert.equal(pending.statusCode, 409);
    assert.equal(pending.headers["retry-after"], "2");
    assert.ok(Buffer.byteLength(pending.body) < COMPARISON_RESPONSE_BYTES);
    platform.repositories.failSummaryAttempt(
      ids[0],
      "measurement-summary.v1",
      token,
      "UNAVAILABLE",
      "run_not_finalized",
      false
    );
    const csv = await app.inject({ method: "GET", url: `${base}/export` });
    assert.equal(csv.statusCode, 200);
    assert.deepEqual(
      csv.body
        .trimEnd()
        .split("\n")
        .slice(1)
        .map((line) => line.split(",")[0]),
      ids
    );
    const read = await app.inject({ method: "GET", url: base });
    assert.equal(read.json().selectionRevision, created.selectionRevision);
    assert.ok(Buffer.byteLength(read.body) < COMPARISON_RESPONSE_BYTES);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
