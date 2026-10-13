import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateRequiredMeasurementGaps } from "../../packages/metrics/src/completeness";
import { MetricSample } from "../../packages/contracts/src/metrics";

const baseLabels = {
  experiment_id: "experiment-1",
  run_id: "run-1",
  variant_id: "baseline",
  repetition: "1",
  component: "observer",
  service: "database",
  phase: "measurement" as const
};

function availability(
  measurement: string,
  value: number,
  reason: string,
  dimensions: Record<string, string> = {}
): MetricSample {
  return {
    metricName: "parkbench_openedge_db_metric_available",
    type: "gauge",
    labels: {
      ...baseLabels,
      family: measurement.startsWith("table_") ? "table_activity" : "bi",
      measurement,
      reason,
      ...dimensions
    },
    timestamp: 1000,
    value,
    source: measurement.startsWith("table_") ? "_TableStat" : "_ActBILog"
  };
}

describe("OpenEdge metric availability and completeness", () => {
  it("records an unavailable measurement as a reasoned gap while accepting an available measured zero", () => {
    const samples: MetricSample[] = [
      availability("table_operations_total", 1, "available", { table: "Customer", operation: "read" }),
      {
        metricName: "parkbench_openedge_db_table_operations_total",
        type: "counter",
        labels: {
          ...baseLabels,
          table: "Customer",
          operation: "read",
          database_epoch: "a".repeat(64)
        },
        timestamp: 1000,
        value: 0,
        source: "_TableStat"
      },
      availability("bi_bytes_written_total", 0, "field_missing")
    ];
    const gaps = calculateRequiredMeasurementGaps(
      [
        { id: "table-read", metricName: "parkbench_openedge_db_table_operations_total", source: "database" },
        { id: "bi-bytes", metricName: "parkbench_openedge_db_bi_bytes_written_total", source: "database" }
      ],
      samples
    );
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].measurementId, "bi-bytes");
    assert.equal(gaps[0].availability, "unsupported");
    assert.equal(gaps[0].availabilityReason, "field_missing");
  });

  it("does not accept a zero database sample without an available record for that dimension", () => {
    const samples: MetricSample[] = [
      {
        metricName: "parkbench_openedge_db_table_operations_total",
        type: "counter",
        labels: {
          ...baseLabels,
          table: "Customer",
          operation: "read",
          database_epoch: "b".repeat(64)
        },
        timestamp: 1000,
        value: 0,
        source: "_TableStat"
      },
      availability("table_operations_total", 0, "statistics_disabled", {
        table: "Customer",
        operation: "read"
      })
    ];
    const gaps = calculateRequiredMeasurementGaps(
      [{ id: "table-read", metricName: "parkbench_openedge_db_table_operations_total", source: "database" }],
      samples
    );
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].availabilityReason, "statistics_disabled");
  });
});
