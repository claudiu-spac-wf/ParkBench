import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CSV_COLUMNS,
  streamComparisonCsv,
  csvValue
} from "../../apps/control-plane/src/comparisons/export";
import { summaryHeader, summaryRow } from "../helpers/summary";
describe("comparison CSV v2", () => {
  it("quotes commas/quotes/CR/LF and rejects non-finite numeric cells", () => {
    assert.equal(csvValue('a,"b\r\nc'), '"a,""b\r\nc"');
    assert.throws(() => csvValue(Infinity));
  });
  it("streams the complete saved selection and all table rows independently of UI pages", async () => {
    const rows: any = {
      b: [summaryRow("Baseline only")],
      v: Array.from({ length: 5000 }, (_, i) => summaryRow("Table" + i))
    };
    const reader: any = {
      read: (id) => ({ status: "READY", header: summaryHeader(id) }),
      find: (id, key) => rows[id].find((r) => r.rowKey === key),
      iterate: async function* (id) {
        yield* rows[id];
      }
    };
    let text = "";
    for await (const chunk of streamComparisonCsv(
      {
        id: "cmp",
        baselineRunId: "b",
        variantRunIds: ["v"],
        selectionRevision: 1,
        createdAt: "now"
      },
      reader
    ))
      text += chunk;
    const lines = text.trimEnd().split("\n");
    assert.deepEqual(lines[0].split(","), CSV_COLUMNS);
    assert.equal(lines.length, 5002);
    assert.match(text, /Table4999/);
    assert.doesNotMatch(text, /# comparison/);
    const header = lines[0].split(","),
      baseline = lines[1].split(",");
    assert.equal(baseline[header.indexOf("total_difference")], "");
  });
  it("defers the whole CSV while any selected summary is pending", async () => {
    const reader: any = {
      read: (id) => ({ status: id === "v" ? "RECOMPUTING" : "READY", header: summaryHeader(id) })
    };
    await assert.rejects(async () => {
      for await (const _ of streamComparisonCsv(
        {
          id: "cmp",
          baselineRunId: "b",
          variantRunIds: ["v"],
          selectionRevision: 1,
          createdAt: "now"
        },
        reader
      )) {
      }
    }, /comparison_summary_pending/);
  });
  it("exports numeric differences for incomplete runs from different experiments", async () => {
    const rows = { b: summaryRow(), v: summaryRow() };
    rows.b.statistics.average.value = 2;
    rows.v.statistics.average.value = 4;
    const reader: any = {
      read: (id) => {
        const header = summaryHeader(id);
        header.run.experimentId = "exp-" + id;
        header.run.state = "FAILED";
        header.run.measurementValidity = "INCOMPLETE";
        header.quality.complete = false;
        return { status: "READY", header };
      },
      find: (id, key) => (rows[id].rowKey === key ? rows[id] : undefined),
      iterate: async function* (id) {
        yield rows[id];
      }
    };
    let text = "";
    for await (const chunk of streamComparisonCsv(
      {
        id: "mixed",
        baselineRunId: "b",
        variantRunIds: ["v"],
        selectionRevision: 1,
        createdAt: "now"
      },
      reader
    ))
      text += chunk;
    const cells = text.trimEnd().split("\n").at(-1)!.split(",");
    assert.equal(cells[CSV_COLUMNS.indexOf("average_difference")], "2");
    assert.equal(cells[CSV_COLUMNS.indexOf("average_difference_percent")], "100");
    assert.equal(cells[CSV_COLUMNS.indexOf("state")], "FAILED");
    assert.equal(cells[CSV_COLUMNS.indexOf("measurement_validity")], "INCOMPLETE");
  });
});

it("fixed fixture CSV bytes are unchanged after read-only selected projections and browser preset mutations", async () => {
  const { createMetricSelectionService } =
    await import("../../apps/control-plane/src/comparisons/metric-selection-service");
  const { createMetricPresetStore } =
    await import("../../apps/web/src/features/comparison/metricPresets");
  const { summaryRun } = await import("../helpers/summary");
  const selection = {
    id: "c",
    selectionRevision: 1,
    createdAt: "now",
    baselineRunId: "b",
    variantRunIds: ["v"]
  };
  const rows = { b: summaryRow(), v: summaryRow() };
  rows.b.statistics.average.value = 100;
  rows.v.statistics.average.value = 120;
  const reader: any = {
    read: (id) => ({ status: "READY", attemptToken: "published", header: summaryHeader(id) }),
    page: (id) => ({ rows: [rows[id]], hasMore: false }),
    find: (id) => rows[id],
    iterate: async function* (id) {
      yield rows[id];
    }
  };
  const download = async () => {
    let text = "";
    for await (const c of streamComparisonCsv(selection, reader)) text += c;
    return text;
  };
  const before = await download();
  const metrics = [
    { metricId: "resource.database.memory.used", statistics: ["average"] as any, selectors: {} }
  ];
  const project = createMetricSelectionService({ reader, lookup: summaryRun });
  await project(selection, {
    contractVersion: "comparison-metric-selection.v1",
    selectionRevision: 1,
    runIds: ["v"],
    metrics
  });
  const values = new Map<string, string>(),
    store = createMetricPresetStore(() => ({
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => {
        values.set(k, v);
      }
    }));
  const p = store.save("Fixed fixture", metrics);
  store.replace(p.id, p.revision, []);
  assert.equal(await download(), before);
});
