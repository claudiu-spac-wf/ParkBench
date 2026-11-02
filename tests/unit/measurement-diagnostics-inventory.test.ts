import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMeasurementInventory,
  persistInventoryPages
} from "../../apps/control-plane/src/measurement-diagnostics/inventory";
import { fixtureMembers } from "../fixtures/measurement-diagnostics/fixtures";
const input = () => ({
  runId: "run-1",
  phase: "measurement",
  startMs: 0,
  endMs: 180000,
  sourceCadenceMs: 5000,
  controllerCadenceMs: 5000,
  scrapeCadenceMs: 1000,
  topology: [
    { group: "database" as const, service: "database", memberId: "db-1" },
    { group: "platform" as const, service: "control-plane", memberId: "cp-1" },
    { group: "platform" as const, service: "node-exporter", memberId: "node-1" }
  ],
  tables: fixtureMembers,
  nativeDimensions: {
    pool: ["primary", "alternate"],
    database_epoch: ["epoch-1"],
    table: fixtureMembers
  },
  paths: [{ file: "db-directory", kind: "directory" as const, evidenceRef: "path-proof-1" }],
  proofs: [],
  views: {}
});
test("inventory retains independently expected members and more than 64 tables even when no samples exist", () => {
  const inventory = buildMeasurementInventory(input());
  const entries = [...inventory.expectations];
  assert.ok(
    entries.some((e) => e.dimensions.member === "node-1" && e.definitionId === "disk.read.bytes")
  );
  const tables = new Set(
    entries.filter((e) => e.definitionId === "db.table.read").map((e) => e.dimensions.table)
  );
  assert.equal(tables.size, 129);
  assert.ok(
    entries.every(
      (e) => e.expectedSlots === 36 && e.sourceCadenceMs === 5000 && e.scrapeCadenceMs === 1000
    )
  );
  assert.equal(new Set(entries.map((e) => e.expectationId)).size, entries.length);
});
test("applicability requires matching scope proof; healthy siblings and known zeros remain expected", () => {
  const options = input();
  (options.proofs as any[]).push({
    definitionId: "db.buffer.logical.read",
    dimensions: { pool: "alternate" },
    applicability: "INAPPLICABLE",
    reasonCode: "alternate_pool_disabled",
    evidenceRefs: ["native-config-b2-zero"]
  });
  const entries = [...buildMeasurementInventory(options).expectations];
  const pools = entries.filter((e) => e.definitionId === "db.buffer.logical.read");
  assert.ok(
    pools
      .filter((e) => e.dimensions.pool === "alternate")
      .every((e) => e.applicability === "INAPPLICABLE")
  );
  assert.ok(
    pools
      .filter((e) => e.dimensions.pool === "primary")
      .every((e) => e.applicability === "EXPECTED")
  );
  assert.ok(
    entries
      .filter((e) => e.definitionId.endsWith("configured_buffers"))
      .every((e) => e.applicability === "EXPECTED")
  );
  assert.ok(
    entries
      .filter((e) => e.definitionId === "disk.space.file_size")
      .every((e) => e.applicability === "UNSUPPORTED" && e.evidenceRefs.includes("path-proof-1"))
  );
  assert.ok(
    entries
      .filter((e) => e.definitionId === "disk.space.allocated")
      .every((e) => e.applicability === "EXPECTED")
  );
});
test("missing applicability evidence remains unresolved; unknown membership never shrinks into an accepted inventory", () => {
  const options = input();
  (options.proofs as any[]).push({
    definitionId: "db.buffer.logical.read",
    dimensions: { pool: "alternate" },
    applicability: "INAPPLICABLE",
    reasonCode: "alternate_pool_disabled",
    evidenceRefs: []
  });
  const entries = [...buildMeasurementInventory(options).expectations];
  assert.ok(
    entries
      .filter(
        (e) => e.definitionId === "db.buffer.logical.read" && e.dimensions.pool === "alternate"
      )
      .every((e) => e.applicability === "UNRESOLVED")
  );
  const unknown = buildMeasurementInventory({ ...input(), tables: undefined, topology: undefined });
  assert.equal(unknown.inventoryIncomplete, true);
  assert.ok(unknown.missingInventoryKinds.includes("topology"));
  assert.ok(unknown.missingInventoryKinds.includes("tables"));
});
test("bounded page persistence preserves identities and reports exhaustion explicitly without changing input inventories", async () => {
  const inventory = buildMeasurementInventory(input());
  const pages: string[] = [];
  const result = await persistInventoryPages(
    inventory,
    async (body) => {
      pages.push(body);
      return true;
    },
    { pageLimitBytes: 8192, totalLimitBytes: 32768 }
  );
  assert.equal(result.inventoryIncomplete, true);
  assert.ok(pages.every((p) => Buffer.byteLength(p) <= 8192));
  assert.ok(result.persistedExpectations > 0);
  assert.equal(input().tables.length, 129);
  const complete = await persistInventoryPages(
    buildMeasurementInventory(input()),
    async () => true,
    { pageLimitBytes: 8192, totalLimitBytes: 8 * 1024 ** 2 }
  );
  // Unknown native dimension inventories remain explicit, regardless of page success.
  assert.equal(complete.truncated, false);
  assert.ok(complete.persistedExpectations > result.persistedExpectations);
});

test("view references use generated Grafana numeric IDs and distinguish physical membership changes", async () => {
  const { measurementPanelInventory } =
    await import("../../apps/control-plane/src/measurement-diagnostics/views");
  const { inventoryMembershipDelta } =
    await import("../../apps/control-plane/src/measurement-diagnostics/inventory");
  const panels = measurementPanelInventory();
  const entries = [...buildMeasurementInventory(input()).expectations];
  const disk = entries.find(
    (e) => e.definitionId === "disk.read.bytes" && e.scope.startsWith("platform")
  )!;
  assert.ok(disk.consumingViews.some((v: any) => v.consumer === "SUMMARY"));
  const charts = disk.consumingViews.filter((v: any) => v.consumer === "GRAFANA") as any[];
  assert.ok(charts.length > 0);
  assert.ok(
    charts.every((v) =>
      panels.some((p) => p.dashboardUid === v.dashboardUid && p.panelId === v.panelId)
    )
  );
  const old = input().topology,
    current = old.map((m) => (m.service === "control-plane" ? { ...m, memberId: "cp-2" } : m));
  const delta = inventoryMembershipDelta("run-1", old, current, 10000, "ownership-snapshot-2");
  assert.deepEqual(
    delta.map((d) => [d.action, d.member.memberId]),
    [
      ["REMOVE", "cp-1"],
      ["ADD", "cp-2"]
    ]
  );
  assert.throws(() => inventoryMembershipDelta("run-1", old, current, 10000, ""));
  assert.equal(old[1].memberId, "cp-1");
});

test("native inventory comes from independent availability/ownership metadata even when metric readings are absent", async () => {
  const { nativeMeasurementInventory } =
    await import("../../packages/observers/src/measurement-inventory");
  const { parseOpenEdgeDbObserverOutput } =
    await import("../../packages/observers/src/openedge-db/adapter");
  const { namedLatchSnapshot } = await import("../helpers/openedge-db-v4");
  const payload = parseOpenEdgeDbObserverOutput(JSON.stringify(namedLatchSnapshot()));
  const before = nativeMeasurementInventory(payload, "owned-run");
  const absent = nativeMeasurementInventory({ ...payload, metrics: [] } as any, "owned-run");
  assert.deepEqual(absent.availability, before.availability);
  assert.deepEqual(absent.dimensions, before.dimensions);
  assert.equal(absent.runId, "owned-run");
  assert.equal(absent.dimensions.latch_id.length, 3);
  assert.ok(!JSON.stringify(absent).includes('"value"'));
  assert.ok(!JSON.stringify(absent).includes('"snapshot"'));
});

test("native latch tuples remain correlated instead of multiplying separate name/type/ID lists", () => {
  const options: any = input();
  options.nativeDimensions = {
    ...options.nativeDimensions,
    database: ["parkbench"],
    latch_id: ["id-1", "id-2", "id-3"],
    latch_name: ["same-name", "second-name"],
    latch_type: ["A", "B"]
  };
  options.nativeIdentities = {
    latch_named_waits_total: [
      { latch_id: "id-1", latch_name: "same-name", latch_type: "A", database_epoch: "epoch-1" },
      { latch_id: "id-2", latch_name: "same-name", latch_type: "B", database_epoch: "epoch-1" },
      { latch_id: "id-3", latch_name: "second-name", latch_type: "B", database_epoch: "epoch-1" }
    ]
  };
  const expected = [...buildMeasurementInventory(options).expectations].filter(
    (e) => e.definitionId === "parkbench_openedge_db_latch_named_waits_total"
  );
  assert.equal(expected.length, 3);
  assert.deepEqual(expected.map((e) => e.dimensions.latch_id).sort(), ["id-1", "id-2", "id-3"]);
});

test("native configuration limits classify exact alternate scopes while dynamic availability remains expected", async () => {
  const { nativeMeasurementInventory } =
    await import("../../packages/observers/src/measurement-inventory");
  const { parseOpenEdgeDbObserverOutput } =
    await import("../../packages/observers/src/openedge-db/adapter");
  const { namedLatchSnapshot } = await import("../helpers/openedge-db-v4");
  const snapshot = namedLatchSnapshot();
  snapshot.collectedAt = new Date().toISOString();
  snapshot.snapshot._Trans = [];
  const native = nativeMeasurementInventory(
    parseOpenEdgeDbObserverOutput(JSON.stringify(snapshot)),
    "owned-run"
  );
  const identities: Record<string, any[]> = {};
  for (const item of native.availability)
    (identities[item.metricName.replace(/^parkbench_openedge_db_/, "")] ??= []).push(
      item.dimensions
    );
  const options: any = {
    ...input(),
    runId: "owned-run",
    tables: native.dimensions.table,
    nativeDimensions: native.dimensions,
    nativeIdentities: identities,
    nativeAvailability: native.availability,
    nativeEvidenceRef: native.evidenceId
  };
  const entries = [...buildMeasurementInventory(options).expectations];
  const alternate = entries.filter(
    (e) => e.definitionId === "db.buffer.logical.read" && e.dimensions.pool === "alternate"
  );
  assert.ok(alternate.length);
  assert.ok(
    alternate.every(
      (e) =>
        e.applicability === "INAPPLICABLE" &&
        e.applicabilityReason === "alternate_pool_disabled" &&
        e.evidenceRefs.includes(native.evidenceId)
    )
  );
  assert.ok(
    entries
      .filter((e) => e.definitionId === "db.buffer.logical.read" && e.dimensions.pool === "primary")
      .every((e) => e.applicability === "EXPECTED")
  );
  const rawAlternate = entries.filter(
    (e) =>
      e.definitionId === "parkbench_openedge_db_buffer_pool_logical_reads_total" &&
      e.dimensions.pool === "alternate"
  );
  assert.equal(rawAlternate.length, 1);
  assert.equal(rawAlternate[0].applicability, "INAPPLICABLE");
  const dynamic = entries.filter(
    (e) => e.definitionId === "parkbench_openedge_db_transaction_oldest_active_age_seconds"
  );
  assert.ok(dynamic.length);
  assert.ok(
    dynamic.every((e) => e.applicability === "EXPECTED"),
    "startup no-transaction state cannot excuse a later supported reading"
  );
  const noProof = [
    ...buildMeasurementInventory({ ...options, nativeEvidenceRef: undefined }).expectations
  ];
  assert.ok(
    noProof
      .filter(
        (e) => e.definitionId === "db.buffer.logical.read" && e.dimensions.pool === "alternate"
      )
      .every((e) => e.applicability === "EXPECTED")
  );
});

test("complete protocol4 application schema proves only the synthetic empty table bucket", async () => {
  const { nativeMeasurementInventory } =
    await import("../../packages/observers/src/measurement-inventory");
  const { parseOpenEdgeDbObserverOutput } =
    await import("../../packages/observers/src/openedge-db/adapter");
  const { namedLatchSnapshot } = await import("../helpers/openedge-db-v4");
  const { FIXTURE_DB_LABELS } = await import("../helpers/openedge-db-v2");
  const snapshot = namedLatchSnapshot();
  snapshot.labels = structuredClone(FIXTURE_DB_LABELS);
  const native = nativeMeasurementInventory(
    parseOpenEdgeDbObserverOutput(JSON.stringify(snapshot)),
    "owned-run"
  );
  assert.deepEqual(native.dimensions.application_table, [...FIXTURE_DB_LABELS.tables].sort());
  assert.deepEqual(native.dimensions.table_inventory_contract, [
    "openedge-db.v4.application-tables-complete"
  ]);
  const identities: Record<string, any[]> = {};
  for (const item of native.availability)
    (identities[item.metricName.replace(/^parkbench_openedge_db_/, "")] ??= []).push(
      item.dimensions
    );
  const options: any = {
    ...input(),
    nativeDimensions: native.dimensions,
    nativeIdentities: identities,
    nativeAvailability: native.availability,
    nativeEvidenceRef: native.evidenceId,
    tables: native.dimensions.table
  };
  const entries = [...buildMeasurementInventory(options).expectations];
  const other = entries.filter(
    (e) =>
      e.definitionId === "parkbench_openedge_db_table_operations_total" &&
      e.dimensions.table === "other"
  );
  assert.equal(other.length, 5);
  assert.ok(
    other.every(
      (e) =>
        e.applicability === "INAPPLICABLE" && e.applicabilityReason === "empty_other_table_scope"
    )
  );
  assert.ok(
    entries
      .filter(
        (e) =>
          e.definitionId === "parkbench_openedge_db_index_operations_total" &&
          e.dimensions.index === "other"
      )
      .every((e) => e.applicability === "EXPECTED")
  );
  const realOther = [
    ...buildMeasurementInventory({
      ...options,
      nativeDimensions: {
        ...native.dimensions,
        application_table: [...native.dimensions.application_table, "Other"]
      }
    }).expectations
  ];
  assert.ok(
    realOther
      .filter(
        (e) =>
          e.definitionId === "parkbench_openedge_db_table_operations_total" &&
          e.dimensions.table === "other"
      )
      .every((e) => e.applicability === "EXPECTED")
  );
  const unproven = [
    ...buildMeasurementInventory({
      ...options,
      nativeDimensions: { ...native.dimensions, table_inventory_contract: [] }
    }).expectations
  ];
  assert.ok(
    unproven
      .filter(
        (e) =>
          e.definitionId === "parkbench_openedge_db_table_operations_total" &&
          e.dimensions.table === "other"
      )
      .every((e) => e.applicability === "EXPECTED")
  );
});
