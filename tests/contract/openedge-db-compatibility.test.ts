import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  OPENEDGE_DB_METRIC_CATALOG,
  getOpenEdgeDbAvailabilityTuples,
  openEdgeDbLabelSet
} from "../../packages/contracts/src/openedge";
import { CORE_METRICS, MetricSample } from "../../packages/contracts/src/metrics";
import { validateOpenEdgeDbObserverPayloadV2 } from "../../packages/contracts/src/openedge";
import { OpenEdgeDatabaseObserverV2 } from "../../packages/observers/src/openedge-db/adapter";
import { addAvailableTableSample, completeOpenEdgeDbPayload } from "../helpers/openedge-db-v2";

const root = process.cwd();

describe("OpenEdge database metric compatibility", () => {
  it("locks the 81 original suffixes plus the raw free-list extension, types, units, source fields, semantics, and dimensions to the contract", () => {
    const baseline = JSON.parse(
      fs.readFileSync(
        path.join(root, "tests/fixtures/openedge/metric-catalog-baseline.json"),
        "utf8"
      )
    );
    assert.equal(OPENEDGE_DB_METRIC_CATALOG.filter((d) => (d.sinceProtocol ?? 2) <= 3).length, 82);
    assert.equal(baseline.entries.length, 81);
    const keys = [
      "name",
      "family",
      "type",
      "unit",
      "semantics",
      "dimensions",
      "sources",
      "sourceFields",
      "fieldMapping"
    ];
    const project = (entry: any) => Object.fromEntries(keys.map((key) => [key, entry[key]]));
    const allocated =
      " Actual primary allocation uses _BuffStatus total minus configured alternate capacity, including the two reserved primary buffers when observed; legacy snapshots without allocation evidence retain -B/-B2 capacity.";
    const corrections: Record<string, any> = {
      buffer_pool_configured_buffers: {
        semantics:
          "Configured capacity, never inferred from activity; `pool=primary|alternate`." +
          allocated,
        sources: ["_DbParams", "effective_run_configuration", "_BuffStatus"],
        sourceFields: [
          "_DbParams._DbParams-Name",
          "_DbParams._DbParams-Value",
          "_BuffStatus._BfStatus-TotBufs"
        ],
        fieldMapping:
          "Effective allocated primary capacity: _BuffStatus._BfStatus-TotBufs minus _DbParams -B2 when verified; otherwise -B/-B2. Alternate capacity is -B2."
      },
      buffer_pool_active_buffers: {
        semantics:
          "Active occupancy from the primary/alternate positional _ActBuffer rows, validated against effective allocated capacity; the combined row is excluded."
      },
      buffer_pool_free_buffers: {
        semantics:
          "Unused configured capacity: capacity minus active occupancy; contradictory or disabled pools are unavailable." +
          allocated,
        sources: ["_ActBuffer", "_DbParams", "effective_run_configuration", "_BuffStatus"],
        sourceFields: [
          "_ActBuffer._Buffer-Active",
          "_DbParams._DbParams-Value",
          "_BuffStatus._BfStatus-TotBufs"
        ],
        fieldMapping:
          "Same-observation effective allocated capacity minus _ActBuffer._Buffer-Active; _BuffStatus includes reserved primary buffers."
      }
    };
    const corrected = baseline.entries.map((entry: any) => ({
      ...entry,
      ...corrections[entry.name]
    }));
    corrected.push({
      ...baseline.entries.find((entry: any) => entry.name === "buffer_pool_free_buffers"),
      name: "buffer_pool_free_list_buffers",
      semantics:
        "Raw VST free-list count by native primary/alternate row; not unused configured capacity."
    });
    // Preserve the reviewed original fixture and compare only the three native-evidenced cache corrections and free-list addition explicitly.
    assert.deepEqual(
      OPENEDGE_DB_METRIC_CATALOG.filter((d) => (d.sinceProtocol ?? 2) <= 3).map(project),
      corrected
        .sort(
          (a: any, b: any) =>
            OPENEDGE_DB_METRIC_CATALOG.findIndex((metric) => metric.name === a.name) -
            OPENEDGE_DB_METRIC_CATALOG.findIndex((metric) => metric.name === b.name)
        )
        .map(project)
    );
  });

  it("covers the public 12.8 patch list without treating unknown patch evidence as support", () => {
    const matrix = JSON.parse(
      fs.readFileSync(
        path.join(root, "tests/fixtures/openedge-12.8/compatibility-matrix.json"),
        "utf8"
      )
    );
    const releases = matrix.releases.map((release: any) => release.release);
    assert.deepEqual(releases, [
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
    ]);
    assert.equal(new Set(releases).size, releases.length);
    assert.equal(releases.includes("12.8.10"), false);
    for (const release of matrix.releases) {
      assert.equal(release.fixture.status, "contract_shape_only");
      assert.equal(release.liveInputs.status, "not_supplied");
      assert.equal(
        release.measurementCoverage &&
          Object.values(release.measurementCoverage).every(
            (status: unknown) => status === "unverified"
          ),
        true
      );
      const fixturePath = path.resolve(root, release.fixture.path);
      const fixtureBytes = fs.readFileSync(fixturePath);
      const payload = JSON.parse(fixtureBytes.toString("utf8"));
      assert.equal(payload.database.productVersion.startsWith(`${release.release}.`), true);
      assert.equal(validateOpenEdgeDbObserverPayloadV2(payload).metrics.length, 0);
      assert.equal(
        payload.families.reduce(
          (count: number, family: any) => count + family.measurements.length,
          0
        ),
        OPENEDGE_DB_METRIC_CATALOG.filter(
          (metric) => metric.name !== "buffer_pool_free_list_buffers"
        ).reduce((count, metric) => count + getOpenEdgeDbAvailabilityTuples(metric).length, 0)
      );
      assert.ok(
        payload.families.every((family: any) =>
          family.measurements.every(
            (measurement: any) =>
              measurement.availability !== "available" && measurement.reason === "not_applicable"
          )
        )
      );
    }
  });

  it("keeps existing public host, workload, and container metrics while adding database metrics", () => {
    for (const name of [
      "parkbench_workload_requests_total",
      "parkbench_host_cpu_utilization_ratio",
      "parkbench_host_disk_read_bytes_total",
      "parkbench_container_cpu_usage_seconds_total",
      "parkbench_container_disk_read_bytes_total"
    ])
      assert.ok(CORE_METRICS.includes(name), `missing public metric ${name}`);
    for (const metric of OPENEDGE_DB_METRIC_CATALOG)
      assert.ok(CORE_METRICS.includes(`parkbench_openedge_db_${metric.name}`));
    assert.ok(openEdgeDbLabelSet().tables.includes("other"));
    assert.ok(openEdgeDbLabelSet().indexes.includes("other"));
  });

  it("keeps compatibility payload context, dimensions, source, and values available to fixtures", () => {
    const fixture = completeOpenEdgeDbPayload();
    assert.equal(fixture.protocolVersion, 2);
    assert.equal(fixture.metrics.length, 0);
    assert.ok(fixture.families.every((family: any) => Array.isArray(family.measurements)));
  });

  it("preserves every metrics.v1 sample field and all context and dimension labels", async () => {
    const payload = completeOpenEdgeDbPayload();
    addAvailableTableSample(payload, "Customer", 8);
    const labels = {
      experiment_id: "exp-1",
      run_id: "run-1",
      variant_id: "variant-a",
      repetition: "2",
      component: "database",
      service: "database",
      phase: "measurement" as const,
      table: "Customer",
      operation: "read"
    };
    const samples: MetricSample[] = await new OpenEdgeDatabaseObserverV2(
      async () => payload
    ).sample({
      runId: labels.run_id,
      experimentId: labels.experiment_id,
      variantId: labels.variant_id,
      repetition: Number(labels.repetition),
      phase: labels.phase
    });
    const projected = samples.filter(
      (sample) => sample.metricName === "parkbench_openedge_db_table_operations_total"
    );
    assert.equal(projected.length, 1);
    assert.deepEqual(projected[0], {
      metricName: "parkbench_openedge_db_table_operations_total",
      type: "counter",
      labels: {
        experiment_id: labels.experiment_id,
        run_id: labels.run_id,
        variant_id: labels.variant_id,
        repetition: labels.repetition,
        component: "observer",
        service: "database",
        phase: labels.phase,
        table: "Customer",
        operation: "read",
        database_epoch: projected[0].labels.database_epoch
      },
      timestamp: Date.parse(payload.collectedAt) / 1000,
      value: 8,
      source: "_TableStat"
    });
    assert.deepEqual(JSON.parse(projected[0].labels.database_epoch ?? "[]"), [
      "2026-09-24T09:00:00Z",
      "2026-09-24T09:00:00Z"
    ]);
  });
});
