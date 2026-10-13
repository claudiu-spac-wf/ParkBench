import { it } from "node:test";
import assert from "node:assert/strict";
import { DATABASE_SUMMARY_CATALOG } from "../../packages/metrics/src/summary-catalog";
import { databaseSummaryRows } from "../../packages/metrics/src/database-summary";
import { validateSummaryRow } from "../../packages/contracts/src/run-summary";
it("uses only the native activity shortlist and emits validated named unavailable siblings", () => {
  const rows = databaseSummaryRows({
    samples: [],
    inventory: { protocolVersion: 3, tables: ["NamedTable"] },
    window: { start: 0, end: 10 },
    cadenceSeconds: 5
  });
  for (const row of rows) {
    validateSummaryRow(row);
    assert.equal(row.group, "database");
    assert.ok(row.totalUnit);
    assert.equal(row.statistics.total?.value, null);
  }
  for (const suffix of [
    "table_operations_total",
    "database_table_operations_total",
    "transaction_commits_total",
    "transaction_rollbacks_total",
    "buffer_pool_logical_reads_total",
    "buffer_pool_logical_writes_total",
    "buffer_pool_os_reads_total",
    "buffer_pool_os_writes_total",
    "database_blocks_read_total",
    "database_blocks_written_total",
    "bi_blocks_written_total",
    "bi_bytes_written_total",
    "bi_io_operations_total"
  ])
    assert.ok(
      DATABASE_SUMMARY_CATALOG.some((d) =>
        d.sourceMetricNames.includes("parkbench_openedge_db_" + suffix)
      ),
      suffix
    );
  assert.equal(
    DATABASE_SUMMARY_CATALOG.some((d) =>
      d.sourceMetricNames.some((m) => /_(?:lock|latch|index)(?:_|s_)/.test(m))
    ),
    false
  );
  assert.equal(rows.filter((r) => r.dimensions.table === "NamedTable").length, 5);
});
