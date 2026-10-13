import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020";
import fs from "node:fs";
import path from "node:path";
import {
  OPENEDGE_DB_FAMILY_NAMES,
  OPENEDGE_DB_METRIC_CATALOG,
  getOpenEdgeDbAvailabilityTuples,
  openEdgeDbLabelSet,
  setOpenEdgeDbLabelSet,
  validateOpenEdgeDbObserverPayloadV2
} from "../../packages/contracts/src/openedge";
import { CORE_METRICS } from "../../packages/contracts/src/metrics";
import { loadContractSchema } from "../../packages/contracts/src/schema-loader";
import {
  FIXTURE_DB_LABELS,
  addAvailableTableSample,
  completeOpenEdgeDbPayload
} from "../helpers/openedge-db-v2";
import { OpenEdgeDatabaseObserverV2 } from "../../packages/observers/src/openedge-db/adapter";

describe("OpenEdge database observer v2 contract", () => {
  it("tracks every publicly listed 12.8 patch and every measurement without claiming unobserved evidence", () => {
    const matrix = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "tests/fixtures/openedge-12.8/compatibility-matrix.json"),
        "utf8"
      )
    );
    assert.deepEqual(
      matrix.requiredMeasurements,
      OPENEDGE_DB_METRIC_CATALOG.filter(
        (item) => (item.sinceProtocol ?? 2) <= 2 && item.name !== "buffer_pool_free_list_buffers"
      ).map((item) => item.name)
    );
    assert.deepEqual(
      matrix.releases.map((release: any) => release.release),
      [
        "12.8.0",
        "12.8.1",
        "12.8.2",
        "12.8.3",
        "12.8.4",
        "12.8.5",
        "12.8.6",
        "12.8.7",
        "12.8.8",
        "12.8.9",
        "12.8.11",
        "12.8.12"
      ]
    );
    for (const release of matrix.releases) {
      assert.equal(release.imageIdentity.status, "not_observed");
      assert.equal(release.runtimeIdentity.expectedPatch, release.release);
      assert.equal(release.fixture.status, "contract_shape_only");
      assert.equal(release.liveInputs.status, "not_supplied");
      assert.deepEqual(Object.keys(release.measurementCoverage), matrix.requiredMeasurements);
      assert.ok(
        Object.values(release.measurementCoverage).every((status) => status === "unverified")
      );
    }
    assert.deepEqual(matrix.excludedVersions, [
      {
        release: "12.8.10",
        status: "not_listed_in_public_release_index",
        evidence: "https://docs.progress.com/category/openedge128-issues-addressed"
      }
    ]);
  });

  it("accepts repeated metric names with distinct bounded dimensions and independent availability", () => {
    const payload = completeOpenEdgeDbPayload();
    addAvailableTableSample(payload, "Customer", 3);
    addAvailableTableSample(payload, "Order", 3);
    const validated = validateOpenEdgeDbObserverPayloadV2(payload);
    assert.equal(
      validated.metrics.filter((metric) => metric.name === "table_operations_total").length,
      2
    );
    assert.equal(
      validated.families
        .find((family) => family.name === "table_activity")
        ?.measurements.filter((measurement) => measurement.availability === "available").length,
      2
    );
  });

  it("requires all canonical families and one availability state for each measurement dimension tuple", () => {
    const payload = completeOpenEdgeDbPayload();
    assert.equal(payload.families.length, OPENEDGE_DB_FAMILY_NAMES.length);
    assert.equal(
      payload.families.reduce((count, family) => count + family.measurements.length, 0),
      OPENEDGE_DB_METRIC_CATALOG.reduce(
        (count, definition) => count + getOpenEdgeDbAvailabilityTuples(definition).length,
        0
      )
    );
    const poolFamily = payload.families.find((family) => family.name === "buffer_pool")!;
    const poolStates = poolFamily.measurements.filter(
      (measurement) => measurement.name === "buffer_pool_active_buffers"
    );
    assert.deepEqual(poolStates.map((measurement) => measurement.labels?.pool).sort(), [
      "alternate",
      "primary"
    ]);
    assert.doesNotThrow(() => validateOpenEdgeDbObserverPayloadV2(payload));
    poolFamily.measurements.pop();
    assert.throws(() => validateOpenEdgeDbObserverPayloadV2(payload), /availability|contract/i);
  });

  it("rejects invalid status/reason pairs, forbidden labels, missing reset timestamps, and duplicate full series", () => {
    const invalidPair = completeOpenEdgeDbPayload();
    const unavailable = invalidPair.families[0].measurements[0];
    unavailable.availability = "unsupported";
    unavailable.reason = "available";
    assert.throws(() => validateOpenEdgeDbObserverPayloadV2(invalidPair), /availability|contract/i);

    const forbiddenLabel = completeOpenEdgeDbPayload();
    addAvailableTableSample(forbiddenLabel, "Customer", 3);
    forbiddenLabel.metrics[0].labels = {
      ...(forbiddenLabel.metrics[0].labels as Record<string, string>),
      username: "must-not-export"
    };
    assert.throws(() => validateOpenEdgeDbObserverPayloadV2(forbiddenLabel), /label|contract/i);

    const missingReset = completeOpenEdgeDbPayload();
    delete (missingReset.database as Record<string, unknown>).statisticsResetAt;
    assert.throws(
      () => validateOpenEdgeDbObserverPayloadV2(missingReset),
      /statisticsResetAt|contract/i
    );

    const duplicate = completeOpenEdgeDbPayload();
    addAvailableTableSample(duplicate, "Customer", 3);
    duplicate.metrics.push(structuredClone(duplicate.metrics[0]));
    assert.throws(() => validateOpenEdgeDbObserverPayloadV2(duplicate), /duplicate|contract/i);
  });

  it("uses the JSON Schema as a closed protocol shape and rejects unrecognized catalog names", () => {
    const schema = loadContractSchema("openedge-db-observer-v2");
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const payload = completeOpenEdgeDbPayload();
    assert.equal(validate(payload), true, JSON.stringify(validate.errors));
    payload.metrics.push({
      name: "made_up_metric",
      type: "gauge",
      unit: "count",
      value: 1,
      source: "_DbStatus",
      labels: {}
    });
    assert.equal(validate(payload), false);
  });

  it("uses only the run database's table labels plus the bounded other bucket", () => {
    assert.deepEqual(openEdgeDbLabelSet().tables, [...FIXTURE_DB_LABELS.tables, "other"]);
    const payload = completeOpenEdgeDbPayload();
    const measurement = payload.families
      .find((family: any) => family.name === "table_activity")
      .measurements.find((item: any) => item.name === "table_operations_total");
    measurement.labels.table = "unlisted-table";
    assert.throws(() => validateOpenEdgeDbObserverPayloadV2(payload), /table|label|contract/i);
  });

  it("uses only the run database's index labels plus the bounded other bucket", () => {
    assert.deepEqual(openEdgeDbLabelSet().indexes, [...FIXTURE_DB_LABELS.indexes, "other"]);
  });

  it("validates a payload for a ParkBenchDB-sized label set (34 tables, 201 indexes)", () => {
    try {
      const tables = Array.from({ length: 34 }, (_, index) => `Table${index}`);
      setOpenEdgeDbLabelSet({
        tables,
        indexes: Array.from({ length: 201 }, (_, index) => `${tables[index % 34]}.Ix${index}`)
      });
      const payload = completeOpenEdgeDbPayload();
      addAvailableTableSample(payload, "Table3", 5);
      validateOpenEdgeDbObserverPayloadV2(structuredClone(payload));
      // Observer /health validates a full payload inside a 3 s probe; keep it well below that.
      const started = performance.now();
      assert.doesNotThrow(() => validateOpenEdgeDbObserverPayloadV2(payload));
      assert.ok(performance.now() - started < 1500, "large-seed payload validation stays fast");
      const measurement = payload.families
        .find((family: any) => family.name === "table_activity")
        .measurements.find((item: any) => item.name === "table_operations_total");
      measurement.labels.table = "NotInSeed";
      assert.throws(() => validateOpenEdgeDbObserverPayloadV2(payload), /table|label|contract/i);
    } finally {
      setOpenEdgeDbLabelSet(FIXTURE_DB_LABELS);
    }
  });

  it("falls back to only the other bucket when a run has no label set", () => {
    try {
      setOpenEdgeDbLabelSet({ tables: [], indexes: [] });
      assert.deepEqual(openEdgeDbLabelSet(), { tables: ["other"], indexes: ["other"] });
      setOpenEdgeDbLabelSet({
        tables: ["Account", "Account", "other"],
        indexes: ["Account.PkAccount"]
      });
      assert.deepEqual(openEdgeDbLabelSet().tables, ["Account", "other"]);
    } finally {
      setOpenEdgeDbLabelSet(FIXTURE_DB_LABELS);
    }
  });

  it("keeps the 82-row metric catalog's exact type, unit, source mapping, and dimensions", () => {
    assert.equal(OPENEDGE_DB_METRIC_CATALOG.filter((d) => (d.sinceProtocol ?? 2) <= 2).length, 82);
    assert.equal(
      new Set(
        OPENEDGE_DB_METRIC_CATALOG.filter((d) => (d.sinceProtocol ?? 2) <= 2).map(
          (metric) => metric.name
        )
      ).size,
      82
    );
    for (const metric of OPENEDGE_DB_METRIC_CATALOG.filter((d) => (d.sinceProtocol ?? 2) <= 2)) {
      assert.match(metric.name, /^[a-z][a-z0-9_]+$/);
      assert.ok(metric.type === "counter" || metric.type === "gauge");
      assert.ok(metric.unit.length > 0);
      assert.ok(metric.fieldMapping.length > 0);
      assert.ok(metric.sources.length > 0);
      assert.ok(
        metric.dimensions.every((label) =>
          ["pool", "table", "index", "operation", "database_epoch"].includes(label)
        )
      );
      if (metric.name.endsWith("_total")) assert.equal(metric.type, "counter");
    }
    assert.ok(CORE_METRICS.includes("parkbench_workload_requests_total"));
    assert.ok(CORE_METRICS.includes("parkbench_container_cpu_usage_seconds_total"));
  });

  it("preserves every metrics.v1 sample envelope field and all run/dimension labels", async () => {
    const payload = completeOpenEdgeDbPayload();
    addAvailableTableSample(payload, "Customer", 17);
    addAvailableTableSample(payload, "Order", 9);
    const samples = await new OpenEdgeDatabaseObserverV2(async () => payload).sample({
      runId: "run-contract",
      experimentId: "experiment-contract",
      variantId: "baseline",
      repetition: 2,
      phase: "measurement"
    });
    const rows = samples.filter(
      (sample) => sample.metricName === "parkbench_openedge_db_table_operations_total"
    );
    assert.equal(rows.length, 2);
    for (const sample of rows) {
      assert.equal(sample.metricName, "parkbench_openedge_db_table_operations_total");
      assert.equal(sample.type, "counter");
      assert.equal(sample.timestamp, Date.parse(payload.collectedAt) / 1000);
      assert.equal(sample.source, "_TableStat");
      assert.equal(sample.value, sample.labels.table === "Customer" ? 17 : 9);
      assert.equal(sample.labels.experiment_id, "experiment-contract");
      assert.equal(sample.labels.run_id, "run-contract");
      assert.equal(sample.labels.variant_id, "baseline");
      assert.equal(sample.labels.repetition, "2");
      assert.equal(sample.labels.component, "observer");
      assert.equal(sample.labels.service, "database");
      assert.equal(sample.labels.phase, "measurement");
      assert.equal(sample.labels.operation, "read");
      assert.equal(JSON.parse(sample.labels.database_epoch ?? "[]").length, 2);
      assert.ok(["Customer", "Order"].includes(sample.labels.table ?? ""));
    }
  });
});
