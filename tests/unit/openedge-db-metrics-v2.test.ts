import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  databaseEpoch,
  selectOpenEdgeStatisticsResetTimestamp,
  validateOpenEdgeDbObserverPayloadV2
} from "../../packages/contracts/src/openedge";
import {
  OpenEdgeDatabaseObserverV2,
  parseOpenEdgeDbObserverV2Output
} from "../../packages/observers/src/openedge-db/adapter";
import {
  addAvailableTableSample,
  completeOpenEdgeDbPayload,
  fixtureCollectorSnapshot
} from "../helpers/openedge-db-v2";

describe("OpenEdge database v2 metric adapter", () => {
  it("preserves repeated metric names with distinct labels and independent unavailable siblings", async () => {
    const payload = completeOpenEdgeDbPayload();
    addAvailableTableSample(payload, "Customer", 17);
    addAvailableTableSample(payload, "Order", 9);
    const itemRead = payload.families
      .find((family: any) => family.name === "table_activity")
      .measurements.find(
        (measurement: any) =>
          measurement.name === "table_operations_total" &&
          measurement.labels.table === "Item" &&
          measurement.labels.operation === "read"
      );
    itemRead.availability = "unsupported";
    itemRead.reason = "field_missing";

    const context = {
      runId: "run-1",
      experimentId: "experiment-1",
      variantId: "baseline",
      repetition: 1,
      phase: "measurement"
    };
    const samples = await new OpenEdgeDatabaseObserverV2(async () => payload).sample(context);
    const tableReads = samples.filter((sample) => sample.metricName === "parkbench_openedge_db_table_operations_total");
    assert.equal(tableReads.length, 2);
    assert.deepEqual(tableReads.map((sample) => sample.labels.table).sort(), ["Customer", "Order"]);
    assert.equal(tableReads[0].labels.run_id, "run-1");
    assert.equal(tableReads[0].labels.phase, "measurement");
    assert.equal(tableReads[0].timestamp, Date.parse(payload.collectedAt) / 1000);
    const status = samples.find(
      (sample) =>
        sample.metricName === "parkbench_openedge_db_metric_available" &&
        sample.labels.measurement === "table_operations_total" &&
        sample.labels.table === "Item" &&
        sample.labels.operation === "read"
    );
    assert.equal(status?.value, 0);
    assert.equal(status?.labels.reason, "field_missing");
  });

  it("rejects non-finite values, type mismatches, invalid labels, and duplicate full series", () => {
    const nonFinite = completeOpenEdgeDbPayload();
    addAvailableTableSample(nonFinite, "Customer", Number.NaN);
    assert.throws(() => validateOpenEdgeDbObserverPayloadV2(nonFinite), /contract_invalid/);

    const wrongType = completeOpenEdgeDbPayload();
    addAvailableTableSample(wrongType, "Customer", 1);
    wrongType.metrics[0].type = "gauge";
    assert.throws(() => validateOpenEdgeDbObserverPayloadV2(wrongType), /contract_invalid/);

    const invalidDimension = completeOpenEdgeDbPayload();
    addAvailableTableSample(invalidDimension, "Customer", 1);
    invalidDimension.metrics[0].labels.table = "arbitrary-user-data";
    assert.throws(() => validateOpenEdgeDbObserverPayloadV2(invalidDimension), /contract_invalid/);

    const duplicate = completeOpenEdgeDbPayload();
    addAvailableTableSample(duplicate, "Customer", 1);
    duplicate.metrics.push(structuredClone(duplicate.metrics[0]));
    assert.throws(() => validateOpenEdgeDbObserverPayloadV2(duplicate), /metric_series_duplicate/);
  });

  it("derives a stable database epoch from trimmed startup and reset strings", () => {
    const first = databaseEpoch(" 2026-09-24T09:00:00Z ", " 2026-09-24T09:15:00Z ");
    const afterReconnect = databaseEpoch("2026-09-24T09:00:00Z", "2026-09-24T09:15:00Z");
    const afterRestart = databaseEpoch("2026-09-24T10:00:00Z", "2026-09-24T09:15:00Z");
    const afterReset = databaseEpoch("2026-09-24T09:00:00Z", "2026-09-24T10:01:00Z");
    assert.equal(first.includes("2026-09-24T09:00:00Z"), true);
    assert.equal(first, afterReconnect);
    assert.notEqual(first, afterRestart);
    assert.notEqual(first, afterReset);
  });

  it("prefers the timezone-aware statistics reset timestamp and trims both inputs", () => {
    assert.equal(
      selectOpenEdgeStatisticsResetTimestamp(" 2026-09-24T10:00:00+03:00 ", "2026-09-24T07:00:00Z"),
      "2026-09-24T10:00:00+03:00"
    );
    assert.equal(
      selectOpenEdgeStatisticsResetTimestamp("  ", " 2026-09-24T07:00:00Z "),
      "2026-09-24T07:00:00Z"
    );
    assert.throws(() => selectOpenEdgeStatisticsResetTimestamp(" ", null), /statistics_reset_missing/);
  });

  it("validates the complete protocol payload before exposing samples", () => {
    const payload = completeOpenEdgeDbPayload();
    assert.deepEqual(parseOpenEdgeDbObserverV2Output(JSON.stringify(payload)), payload);
    assert.throws(() => parseOpenEdgeDbObserverV2Output("not-json"), /contract_invalid:json/);
    assert.throws(() => parseOpenEdgeDbObserverV2Output('{"protocolVersion":1}'), /contract_invalid/);
  });

  it("computes counter epochs from database identity instead of trusting the ABL output", () => {
    const payload = completeOpenEdgeDbPayload();
    addAvailableTableSample(payload, "Customer", 4);
    delete payload.metrics[0].labels.database_epoch;
    const parsed = parseOpenEdgeDbObserverV2Output(JSON.stringify(payload));
    assert.equal(parsed.metrics[0].labels.database_epoch, databaseEpoch(
      payload.database.startedAt,
      payload.database.statisticsResetAt
    ));
  });

  it("normalizes a read-only Sports2020 VST snapshot into bounded metrics and truthful availability", () => {
    const payload = parseOpenEdgeDbObserverV2Output(JSON.stringify(fixtureCollectorSnapshot()));
    const metric = (name: string, labels: Record<string, string> = {}) =>
      payload.metrics.find(
        (item) => item.name === name && Object.entries(labels).every(([key, value]) => item.labels[key] === value)
      );
    const availability = (name: string, labels: Record<string, string> = {}) =>
      payload.families.flatMap((family) => family.measurements).find(
        (item) => item.name === name && Object.entries(labels).every(([key, value]) => item.labels?.[key] === value)
      );
    assert.equal(payload.database.startedAt, "2026-09-24T09:00:00Z");
    assert.equal(payload.database.statisticsResetAt, "2026-09-24T09:30:00+03:00");
    assert.equal(metric("buffer_pool_os_reads_total", { pool: "primary" })?.value, 2);
    assert.equal(metric("buffer_pool_cumulative_cache_hit_ratio", { pool: "primary" })?.value, 0.8);
    assert.equal(availability("buffer_pool_configured_buffers", { pool: "alternate" })?.availability, "not_configured");
    assert.equal(metric("table_operations_total", { table: "Customer", operation: "read" })?.value, 5);
    assert.equal(metric("table_operations_total", { table: "other", operation: "read" })?.value, 7);
    assert.equal(metric("index_operations_total", { index: "Customer.CustNum", operation: "read" })?.value, 4);
    assert.equal(metric("checkpoint_last_duration_seconds")?.value, 2);
    assert.equal(metric("bi_blocks_written_total")?.value, 7);
    assert.equal(metric("bi_bytes_written_total")?.value, 56);
    assert.equal(metric("bi_file_size_bytes")?.value, 16 * 8192);
    assert.equal(metric("bi_cluster_count")?.value, 1);
    assert.equal(metric("bi_buffered_io_enabled")?.value, 0);
    assert.equal(metric("recovery_log_threshold_bytes")?.value, 5 * 1_048_576);
    assert.equal(metric("transaction_active_count")?.value, 2);
    assert.equal(metric("transaction_oldest_active_age_seconds")?.value, 10);
    assert.equal(metric("latch_lock_duration_seconds_total")?.value, 1.5);
    assert.equal(metric("latch_wait_or_spin_duration_seconds_total")?.value, 3);
    assert.equal(metric("lock_requests_total", { operation: "exclusive" })?.value, 8);
    assert.equal(metric("lock_grants_total", { operation: "exclusive" })?.value, 9);
    assert.ok(payload.metrics.every((item) =>
      item.type !== "counter" || item.labels.database_epoch === databaseEpoch(payload.database.startedAt, payload.database.statisticsResetAt)
    ));
  });

  it("folds unlisted table rows into other and sums their counters without leaking object names", () => {
    const payload = completeOpenEdgeDbPayload();
    const family = payload.families.find((item: any) => item.name === "table_activity");
    family.measurements = family.measurements.filter(
      (item: any) =>
        !(item.name === "table_operations_total" && item.labels.table === "other" && item.labels.operation === "read")
    );
    for (const table of ["UnlistedOne", "UnlistedTwo"]) {
      family.measurements.push({
        name: "table_operations_total",
        availability: "available",
        source: "_TableStat",
        reason: "available",
        labels: { table, operation: "read" }
      });
      payload.metrics.push({
        name: "table_operations_total",
        type: "counter",
        unit: "table operations",
        value: table === "UnlistedOne" ? 4 : 7,
        source: "_TableStat",
        labels: {
          table,
          operation: "read",
          database_epoch: databaseEpoch(
            payload.database.startedAt,
            payload.database.statisticsResetAt
          )
        }
      });
    }
    const normalized = parseOpenEdgeDbObserverV2Output(JSON.stringify(payload));
    const other = normalized.metrics.find(
      (metric) => metric.name === "table_operations_total" && metric.labels.table === "other" && metric.labels.operation === "read"
    );
    assert.equal(other?.value, 11);
    assert.equal(JSON.stringify(normalized).includes("UnlistedOne"), false);
    assert.equal(JSON.stringify(normalized).includes("UnlistedTwo"), false);
  });
});
