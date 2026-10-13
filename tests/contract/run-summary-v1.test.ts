import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateSummaryHeader,
  validateSummaryRow,
  validateSummaryStream,
  validateRunContext,
  semanticRowKey
} from "../../packages/contracts/src/run-summary";
import { summaryHeader, summaryRow } from "../helpers/summary";
describe("run-summary.v1", () => {
  it("validates identity, units, coverage and finite nullable statistics", () => {
    const r = summaryRow("A");
    validateSummaryHeader(summaryHeader(), "run-test");
    validateSummaryRow(r);
    assert.equal(r.rowKey, semanticRowKey(r));
    assert.throws(() => validateSummaryHeader(summaryHeader(), "other"));
    for (const patch of [
      { group: "unknown" },
      { dimensions: { job: "x" } },
      { rowKey: "wrong" },
      { statistics: { ...r.statistics, average: { ...r.statistics.average, value: Infinity } } },
      { coverage: { ...r.coverage, observedSeconds: 99 } }
    ])
      assert.throws(() => validateSummaryRow({ ...r, ...patch }));
    assert.throws(() =>
      validateSummaryRow({
        ...r,
        statistics: {
          ...r.statistics,
          average: { ...r.statistics.average, value: null, reasons: [] }
        }
      })
    );
    validateSummaryRow({
      ...r,
      statistics: {
        ...r.statistics,
        average: {
          ...r.statistics.average,
          value: null,
          status: "unavailable",
          reasons: ["insufficient_data"]
        }
      }
    });
  });
  it("rejects unsupported version/state/status/statistic and baseline-bearing documents", () => {
    for (const patch of [
      { contractVersion: "run-summary.v0" },
      { metricDefinitionsVersion: "old" },
      { baselineRunId: "x" },
      { windows: { ...summaryHeader().windows, measurement: { state: "bad" } } }
    ])
      assert.throws(() => validateSummaryHeader({ ...summaryHeader(), ...patch }));
    const r = summaryRow();
    assert.throws(() =>
      validateSummaryRow({ ...r, statistics: { ...r.statistics, p99: r.statistics.p95 } })
    );
    assert.throws(() =>
      validateSummaryRow({
        ...r,
        statistics: { ...r.statistics, p95: { ...r.statistics.p95, status: "valid" } }
      })
    );
  });
  it("requires statistic-specific additive contributor coverage and total units", () => {
    const r = summaryRow("A");
    const coverage = {
      ...r.coverage,
      coverageModel: "constituent_additive",
      supportedContributors: 2,
      incompleteContributors: 1,
      constituentSelector: {
        definitionIds: ["db.table.read"],
        group: "database",
        coverageScope: "table_covered"
      }
    };
    validateSummaryRow({
      ...r,
      statistics: { ...r.statistics, total: { ...r.statistics.total, coverage } }
    });
    assert.throws(() =>
      validateSummaryRow({
        ...r,
        statistics: {
          ...r.statistics,
          total: { ...r.statistics.total, coverage: { ...coverage, supportedContributors: -1 } }
        }
      })
    );
  });
  it("bounds header/row/context separately, preserves requested/effective/observed", () => {
    assert.throws(() =>
      validateSummaryHeader({ ...summaryHeader(), workload: { text: "x".repeat(2 * 1024 * 1024) } })
    );
    assert.throws(() => validateSummaryRow({ ...summaryRow(), displayName: "x".repeat(16384) }));
    const context = {
      contractVersion: "run-context.v1",
      runId: "run-test",
      scenario: {},
      requested: { x: 1 },
      effective: { x: 2 },
      observed: { x: 3 },
      inputs: {},
      loadSeed: 1,
      host: {},
      tools: {},
      images: {},
      sources: [],
      capturedAt: "2026-09-30T00:00:00.000Z"
    };
    validateRunContext(context, "run-test");
    assert.throws(() =>
      validateRunContext({ ...context, inputs: { text: "x".repeat(4 * 1024 * 1024) } }, "run-test")
    );
  });
  it("validates streamed full artifacts beyond 4096 rows and rejects duplicate/count mismatch", async () => {
    const n = 5000;
    async function* rows() {
      for (let i = 0; i < n; i++) yield summaryRow("Table" + i);
    }
    await validateSummaryStream(
      { ...summaryHeader(), totalRowCount: n, tableRowCount: n },
      rows(),
      "run-test"
    );
    async function* duplicates() {
      yield summaryRow("A");
      yield summaryRow("A");
    }
    await assert.rejects(() =>
      validateSummaryStream(
        { ...summaryHeader(), totalRowCount: 2, tableRowCount: 2 },
        duplicates(),
        "run-test"
      )
    );
    await assert.rejects(() =>
      validateSummaryStream(
        { ...summaryHeader(), totalRowCount: 1, tableRowCount: 1 },
        rows(),
        "run-test"
      )
    );
  });
});
