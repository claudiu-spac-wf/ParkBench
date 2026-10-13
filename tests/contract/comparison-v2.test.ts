import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildComparison,
  normalizeComparisonSelection
} from "../../apps/control-plane/src/comparisons/service";
import { compareSummaryRow } from "../../apps/control-plane/src/comparisons/comparison-service";
import { summaryHeader, summaryRow, summaryRun } from "../helpers/summary";
function reader(
  rows: any = { b: [summaryRow("A")], v: [summaryRow("A")] },
  headers: any = { b: summaryHeader("b"), v: summaryHeader("v") }
): any {
  return {
    read: (id: string) => ({
      status: "READY",
      header: headers[id],
      attemptToken: id,
      artifactPath: id + "/summary"
    }),
    page: (id: string, options: any) => {
      const list = (rows[id] ?? []).filter((r) =>
          options?.tablesOnly ? !!r.dimensions.table : !r.dimensions.table
        ),
        offset = Number(options?.cursor ?? 0),
        page = list.slice(offset, offset + (options?.limit ?? 100)),
        hasMore = offset + page.length < list.length;
      return {
        rows: page,
        hasMore,
        totalRowCount: list.length,
        returnedRowCount: page.length,
        nextCursor: hasMore ? String(offset + page.length) : undefined
      };
    },
    find: (id: string, key: string) => (rows[id] ?? []).find((r) => r.rowKey === key),
    iterate: async function* (id: string) {
      yield* rows[id] ?? [];
    }
  };
}
describe("comparison.v2", () => {
  it("preserves exact deduplicated order and permits baseline-only/changed inputs", () => {
    const normalize = normalizeComparisonSelection({
      id: "cmp",
      createdAt: "now",
      baselineRunId: "b",
      variantRunIds: ["v", "b", "v"]
    });
    assert.deepEqual(normalize.variantRunIds, ["v"]);
    assert.throws(
      () => normalizeComparisonSelection({ id: "cmp", createdAt: "now", variantRunIds: [] }),
      /comparison_selection_empty/
    );
    const result = buildComparison(normalize, reader(), (id) => ({
      ...summaryRun(id),
      environmentSnapshot: { seed: id }
    }));
    assert.deepEqual(result.selectionPage.runIds, ["b", "v"]);
    assert.equal(result.contractVersion, "comparison.v2");
    assert.equal(
      buildComparison({ ...normalize, variantRunIds: [] }, reader(), (id) => summaryRun(id)).runs
        .length,
      1
    );
  });
  it("matches stable semantic rows and compares available numbers regardless of run quality", () => {
    const a = summaryRow(),
      b = summaryRow();
    a.statistics.average.value = 3;
    b.statistics.average.value = 0;
    const h = summaryHeader();
    const r = compareSummaryRow(a, b, h, h, false);
    assert.equal(r.differences.average.absoluteDifference, 3);
    assert.equal(r.differences.average.percentageDifference, null);
    assert.equal(r.differences.average.reason, "zero_baseline");
    assert.equal(
      compareSummaryRow(a, b, { ...h, run: { ...h.run, state: "FAILED" } }, h, false).differences
        .average.absoluteDifference,
      3
    );
    a.statistics.p95 = {
      ...a.statistics.p95,
      value: null,
      status: "unavailable",
      reasons: ["insufficient_data"]
    };
    b.statistics.average.value = 1;
    const optional = compareSummaryRow(a, b, h, h, false);
    assert.equal(optional.differences.average.absoluteDifference, 2);
    assert.equal(optional.differences.p95.absoluteDifference, null);
  });
  it("does not derive historical numbers from legacy generic summaries", () => {
    const r = buildComparison(
      { id: "cmp", createdAt: "now", variantRunIds: ["v"], selectionRevision: 1 },
      { ...reader(), read: () => ({ status: "LEGACY", reason: "legacy_semantics" }) },
      (id) => ({ ...summaryRun(id), summary: { summaries: [{ mean: 999 }] } })
    );
    assert.equal(r.runs[0].rows.length, 0);
    assert.equal(r.runs[0].summary.status, "LEGACY");
  });
  it("compares failed, cancelled and incomplete baselines and variants without changing recorded quality", () => {
    for (const state of ["SUCCEEDED", "FAILED", "CANCELLED"]) {
      const a = summaryRow(),
        b = summaryRow();
      a.statistics.average.value = 4;
      b.statistics.average.value = 2;
      const h = summaryHeader();
      h.run.state = state;
      h.run.measurementValidity = "INCOMPLETE";
      h.quality.complete = false;
      h.quality.requiredGaps = [{ observerId: "missing" }];
      const difference = compareSummaryRow(a, b, h, h).differences.average;
      assert.equal(difference?.absoluteDifference, 2);
      assert.equal(difference?.percentageDifference, 100);
      assert.equal(h.run.state, state);
      assert.equal(h.quality.complete, false);
      a.statistics.average.value = Infinity;
      assert.equal(compareSummaryRow(a, b, h, h).differences.average?.absoluteDifference, null);
    }
  });
  it("warns only for different recorded scenarios over the full saved selection, beyond the current page", () => {
    const selection = {
      id: "cmp",
      createdAt: "now",
      baselineRunId: "b",
      variantRunIds: ["v"],
      selectionRevision: 1
    };
    const lookup = (id: string) => ({
      ...summaryRun(id),
      experimentId: "experiment-" + id,
      environmentSnapshot: {
        scenario: {
          id: "same",
          version: "1",
          workload: { name: id },
          phases: { measurementSeconds: id === "b" ? 30 : 300 }
        },
        seed: id
      }
    });
    const same = buildComparison(selection, reader(), lookup, { limit: 1 });
    assert.equal(same.runs.length, 1);
    assert.deepEqual(same.warnings, []);
    const different = buildComparison(
      selection,
      reader(),
      (id) => {
        const run = lookup(id);
        if (id === "v") run.environmentSnapshot.scenario.id = "different";
        return run;
      },
      { limit: 1 }
    );
    assert.equal(different.runs.length, 1);
    assert.deepEqual(
      different.warnings.map((w) => w.code),
      ["different_scenarios"]
    );
    assert.deepEqual(different.selectionPage.runIds, ["b", "v"]);
    const unknown = buildComparison(selection, reader(), (id) => summaryRun(id));
    assert.deepEqual(unknown.warnings, []);
    const partial = buildComparison(selection, reader(), (id) => ({
      ...lookup(id),
      environmentSnapshot: {
        scenario:
          id === "b" ? { id: "same", version: "1", fingerprint: "recorded" } : { id: "same" }
      }
    }));
    assert.deepEqual(partial.warnings, []);
  });
});
