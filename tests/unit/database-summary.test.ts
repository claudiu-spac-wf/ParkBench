import { describe, it } from "node:test";
import assert from "node:assert/strict";
const contextLabels = {
  experiment_id: "e",
  variant_id: "v",
  repetition: "1",
  component: "observer",
  service: "database",
  phase: "measurement" as const
};
import { databaseSummaryRows } from "../../packages/metrics/src/database-summary";
const metric = (
  table: string,
  operation: string,
  values: number[][],
  epoch = "opaque:start/reset"
) =>
  values.map(([timestamp, value]) => ({
    metricName: "parkbench_openedge_db_table_operations_total",
    type: "counter" as const,
    value,
    timestamp,
    labels: {
      ...contextLabels,
      table,
      operation,
      database_epoch: epoch,
      run_id: "r",
      job: "parkbench-run-observers"
    },
    source: "_TableStat"
  }));
const row = (rows: any[], id: string, table?: string) =>
  rows.find((r) => r.definitionId === id && r.dimensions.table === table);
describe("database measurement summaries", () => {
  it("keeps additive total coverage separate from contemporaneous rate coverage", () => {
    const rows = databaseSummaryRows({
      samples: [
        ...metric("A", "read", [
          [0, 0],
          [2.5, 2.5],
          [5, 5],
          [7.5, 7.5],
          [10, 10]
        ]),
        ...metric("B", "read", [
          [0, 0],
          [2.5, 2.5],
          [5, 5]
        ])
      ],
      inventory: { protocolVersion: 3, tables: ["A", "B"] },
      window: { start: 0, end: 10 },
      cadenceSeconds: 2.5
    });
    const total = row(rows, "db.tables.aggregate.read");
    assert.equal(total.statistics.total.value, 15);
    assert.equal(total.statistics.total.status, "partial");
    assert.equal(total.statistics.average.value, 2);
    assert.equal(total.statistics.average.coverage.observedSeconds, 5);
    assert.equal(total.statistics.total.coverage.supportedContributors, 2);
    assert.equal(total.statistics.total.coverage.incompleteContributors, 1);
  });
  it("derives writes from reset-safe create/update/delete and excludes os_read", () => {
    const rows = databaseSummaryRows({
      samples: [
        ...metric("A", "create", [
          [0, 0],
          [1, 1],
          [2, 2]
        ]),
        ...metric("A", "update", [
          [0, 0],
          [1, 2],
          [2, 4]
        ]),
        ...metric("A", "delete", [
          [0, 0],
          [1, 3],
          [2, 6]
        ]),
        ...metric("A", "os_read", [
          [0, 0],
          [1, 1000],
          [2, 2000]
        ])
      ],
      inventory: { protocolVersion: 3, tables: ["A"] },
      window: { start: 0, end: 2 },
      cadenceSeconds: 1
    });
    assert.equal(row(rows, "db.table.write", "A").statistics.total.value, 12);
    assert.equal(row(rows, "db.tables.aggregate.write").statistics.total.value, 12);
    assert.equal(
      rows.some((r) => r.dimensions.operation === "os_read"),
      false
    );
  });
  it("keeps opaque epochs, supported zero and missing optional operations distinct", () => {
    const samples = [
      ...metric("A", "read", [
        [0, 50],
        [1, 50]
      ]),
      ...metric(
        "A",
        "read",
        [
          [2, 0],
          [3, 1]
        ],
        "next epoch"
      )
    ];
    const rows = databaseSummaryRows({
      samples,
      inventory: {
        protocolVersion: 3,
        tables: ["A"],
        availability: [
          {
            table: "A",
            operation: "update",
            availability: "not_configured",
            reason: "statistics_range_excludes_object"
          }
        ]
      },
      window: { start: 0, end: 3 },
      cadenceSeconds: 1
    });
    assert.equal(row(rows, "db.table.read", "A").statistics.total.value, 1);
    assert.equal(row(rows, "db.table.read", "A").statistics.total.status, "partial");
    assert.equal(row(rows, "db.table.update", "A").statistics.total.value, null);
    assert.ok(
      row(rows, "db.table.update", "A").sourceReferences.some(
        (s: any) => s.source === "statistics_range_excludes_object"
      )
    );
  });
  it("retains all 1000 names, genuine Other and more than 4096 rows without ranking", () => {
    const tables = Array.from({ length: 1000 }, (_, i) => `Table${i}`),
      samples = tables.flatMap((t, i) =>
        metric(t, "read", [
          [0, 0],
          [1, i]
        ])
      );
    samples.push(
      ...metric("other", "read", [
        [0, 0],
        [1, 3]
      ])
    );
    const rows = databaseSummaryRows({
      samples,
      inventory: { protocolVersion: 3, tables },
      window: { start: 0, end: 1 },
      cadenceSeconds: 1
    });
    assert.equal(rows.filter((r) => r.dimensions.table).length, 5005);
    assert.equal(row(rows, "db.tables.aggregate.read").statistics.total.value, 499503);
    assert.equal(row(rows, "db.table.read", "Table999").statistics.total.value, 999);
    assert.equal(
      rows.some((r) => r.dimensions.table === "Other"),
      false
    );
  });
  it("keeps independent native and table-covered scopes without forcing reconciliation", () => {
    const native = metric("A", "read", [
      [0, 0],
      [1, 100]
    ]).map((s) => ({
      ...s,
      metricName: "parkbench_openedge_db_database_table_operations_total",
      labels: {
        ...contextLabels,
        operation: s.labels.operation,
        database_epoch: s.labels.database_epoch,
        run_id: "r",
        job: "parkbench-run-observers"
      }
    }));
    const rows = databaseSummaryRows({
      samples: [
        ...native,
        ...metric("A", "read", [
          [0, 0],
          [1, 2]
        ])
      ],
      inventory: { protocolVersion: 2, tables: ["A"] },
      window: { start: 0, end: 1 },
      cadenceSeconds: 1
    });
    assert.equal(row(rows, "db.records.read").statistics.total.value, 100);
    assert.equal(row(rows, "db.tables.aggregate.read").statistics.total.value, 2);
    assert.equal(row(rows, "db.records.read").coverageScope, "database_native");
    assert.equal(row(rows, "db.tables.aggregate.read").coverageScope, "table_covered");
  });
});
