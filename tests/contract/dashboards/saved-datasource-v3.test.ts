import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ParameterSnapshotQueries } from "../../../apps/control-plane/src/grafana/parameter-snapshots";
import { SavedSummaryQueries } from "../../../apps/control-plane/src/grafana/summary-results";
import { ArtifactStorage } from "../../../apps/control-plane/src/artifacts/storage";
import { summaryHeader, summaryRow, summaryRun } from "../../helpers/summary";
test("retained primary plaintext/numeric/status snapshot preserves UTC capture independently of visible/aligned time", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "saved-snapshot-"));
  try {
    const snapshot = {
      contractVersion: "db-parameter-snapshot.v1",
      runId: "run-test",
      experimentId: "exp-test",
      variantId: "v1",
      repetition: 1,
      databaseName: "actual-db",
      attemptedAt: "2026-09-30T00:00:00Z",
      capturedAt: "2026-09-30T00:00:01Z",
      status: "complete",
      rowCount: 2,
      source: "_DbParams",
      rows: [
        {
          name: "-B",
          displayValue: "4096",
          numericValue: 4096,
          valueStatus: "recorded",
          dtype: 4,
          isDefault: false
        },
        {
          name: "-custom",
          displayValue: "plain UTF-8 東京",
          valueStatus: "recorded",
          dtype: 1,
          isDefault: false
        }
      ],
      verificationResults: []
    };
    const storage = new ArtifactStorage(root);
    storage.write("run-test/params.json", JSON.stringify(snapshot));
    const reader = new ParameterSnapshotQueries(
      {
        getRun: () => summaryRun(),
        listArtifacts: () => [{ kind: "db_parameter_snapshot", path: "run-test/params.json" }]
      } as any,
      storage
    );
    const noQuery = async () => {
      throw new Error("retained snapshot must not query Prometheus");
    };
    const info = await reader.query("run-test", "info", 946684800000, noQuery);
    assert.equal(info[1].metric.display_value, "plain UTF-8 東京");
    assert.equal(info[0].value[1], String(Date.parse(snapshot.capturedAt)));
    assert.equal(info[0].value[0], 946684800);
    const numeric = await reader.query("run-test", "numeric", 946684800000, noQuery);
    assert.equal(numeric.length, 1);
    assert.equal(numeric[0].value[1], "4096");
    assert.equal(
      (await reader.query("run-test", "status", 946684800000, noQuery))[0].metric.state,
      "complete"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("Grafana saved statistics equal the persisted row values; chart narrowing issues no raw query", async () => {
  const row = summaryRow();
  const header = summaryHeader();
  const reader = {
    read: () => ({ status: "READY", attemptToken: "a", header }),
    page: () => ({ rows: [row], totalRowCount: 1 }),
    iterate: async function* () {
      yield row;
    }
  };
  const adapter = new SavedSummaryQueries(reader as any);
  const labels = new Map([["scope", "resource"]]);
  const before = await adapter.query(
    "run-test",
    labels,
    Date.parse(header.windows.measurement.end)
  );
  const after = await adapter.query("run-test", labels, 946684800000);
  assert.deepEqual(
    before.map((r) => r.value[1]),
    after.map((r) => r.value[1])
  );
  assert.equal(after[0].value[1], String(row.statistics.average.value));
  assert.equal(after[0].metric.unit, row.rateOrLevelUnit);
  assert.equal(after[0].metric.window_start, header.windows.measurement.start);
});

test("saved table ranking uses observed totals, preserves missing states and reconciles additive display Other", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => {
    const row = summaryRow(`T${String(i).padStart(3, "0")}`);
    row.statistics.total.observedTotal = i;
    row.statistics.total.estimatedTotal = 1;
    row.statistics.total.value = i + 1;
    return row;
  });
  const genuine = summaryRow("other");
  genuine.statistics.total.value = 5;
  genuine.statistics.total.observedTotal = 5;
  genuine.statistics.total.estimatedTotal = 0;
  rows.push(genuine);
  const unknown = summaryRow("unknown");
  unknown.statistics.total.value = null;
  unknown.statistics.total.status = "unavailable";
  unknown.statistics.total.observedTotal = 0;
  rows.push(unknown);
  const reader = {
    read: () => ({ status: "READY", attemptToken: "a", header: summaryHeader() }),
    iterate: async function* () {
      yield* rows;
    },
    page: () => ({ rows: [] })
  };
  const result = await new SavedSummaryQueries(reader as any).query(
    "run-test",
    new Map([
      ["ranking", "top10"],
      ["definition", "db.table.read"]
    ]),
    0
  );
  assert.equal(result.length, 11);
  assert.ok(result.some((r) => r.metric.table === "T099"));
  assert.equal(
    result.some((r) => r.metric.table === "unknown"),
    false
  );
  const remainder = result.find((r) => r.metric.display_remainder);
  assert.equal(remainder.metric.status, "partial");
  assert.equal(remainder.metric.unknown_constituents, "1");
  assert.equal(remainder.metric.observed_total, String(4005 + 5));
  assert.equal(
    result.reduce((n, r) => n + Number(r.value[1]), 0),
    5050 + 5
  );
  assert.equal(
    rows.some((r) => r.dimensions.table === "Other"),
    false
  );
});
