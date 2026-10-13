import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fixture from "../fixtures/metrics/all-table-native-v3.json";
import {
  parseOpenEdgeDbObserverOutput,
  parseOpenEdgeDbObserverV2Output,
  OpenEdgeDatabaseObserverV3,
  readOpenEdgeDbObserverPayload
} from "../../packages/observers/src/openedge-db/adapter";
import {
  validateOpenEdgeDbObserverPayloadV3,
  setOpenEdgeDbLabelSet,
  OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION
} from "../../packages/contracts/src/openedge";
import { completeOpenEdgeDbPayload } from "../helpers/openedge-db-v2";
describe("all-table native protocol v3", () => {
  afterEach(() => setOpenEdgeDbLabelSet(undefined));
  it("reports broker capacity errors written to stdout by a failed native command", async () => {
    await assert.rejects(
      readOpenEdgeDbObserverPayload({
        executable: process.execPath,
        procedure: "-e",
        allowNonProcedure: true,
        args: [
          'console.log("The server or the system has no more resources. (748)\\nPlease see startup parameters -Ma, -Mn, and -n. (19489)");process.exit(2)'
        ]
      }),
      /openedge_db_observer_connection_capacity_exhausted/
    );
  });
  it("retains all 70 actual names including the busiest name beyond the former cap", () => {
    assert.equal(OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION, 4);
    const payload = parseOpenEdgeDbObserverOutput(JSON.stringify(fixture));
    assert.equal(payload.protocolVersion, 3);
    const metrics = payload.metrics.filter(
      (m) => m.name === "table_operations_total" && m.labels.operation === "read"
    );
    assert.equal(metrics.length, 70);
    assert.equal(metrics.find((m) => m.labels.table === "Table0069")?.value, 100000);
    assert.equal(
      metrics.some((m) => m.labels.table === "other"),
      false
    );
    assert.equal(validateOpenEdgeDbObserverPayloadV3(payload), payload);
  });
  it("validates inventory-aware snapshots larger than the old raw and family caps", () => {
    const input = structuredClone(fixture);
    const row = input.snapshot._TableStat[0];
    input.labels.tables = Array.from({ length: 2000 }, (_, i) => `T${i}`);
    input.snapshot._TableStat = input.labels.tables.map((table) => ({ ...row, table }));
    const result = parseOpenEdgeDbObserverOutput(JSON.stringify(input));
    assert.equal(result.metrics.filter((m) => m.name === "table_operations_total").length, 10000);
    assert.ok(result.families.find((f) => f.name === "table_activity")!.measurements.length > 8192);
  });
  it("preserves cached capture time, epoch, counter type and every canonical label", async () => {
    const result = parseOpenEdgeDbObserverOutput(JSON.stringify(fixture));
    const samples = await new OpenEdgeDatabaseObserverV3(async () => result).sample({
      runId: "run-readable",
      experimentId: "e",
      variantId: "v",
      repetition: 1,
      phase: "measurement"
    });
    const last = samples.find(
      (s) => s.labels.table === "Table0069" && s.labels.operation === "read" && s.type === "counter"
    );
    assert.equal(last?.timestamp, Date.parse(fixture.collectedAt) / 1000);
    assert.ok(last?.labels.database_epoch);
  });
  it("rejects malformed inventories, tuples, duplicate series and unadvertised table names", () => {
    const valid = parseOpenEdgeDbObserverOutput(JSON.stringify(fixture));
    for (const change of [
      (p: any) => p.labels.tables.push(p.labels.tables[0]),
      (p: any) => (p.metrics[0].labels.table = "NotInventoried"),
      (p: any) => p.metrics.push(p.metrics[0]),
      (p: any) => (p.metrics[0].value = Infinity)
    ]) {
      const bad = structuredClone(valid);
      change(bad);
      assert.throws(() => validateOpenEdgeDbObserverPayloadV3(bad), /contract_invalid/);
    }
  });
  it("keeps explicit retained-v2 semantics and rejects v3 through that reader", () => {
    const old = completeOpenEdgeDbPayload();
    assert.equal(parseOpenEdgeDbObserverV2Output(JSON.stringify(old)).protocolVersion, 2);
    assert.throws(() => parseOpenEdgeDbObserverV2Output(JSON.stringify(fixture)), /protocol/);
    const legacy = { ...structuredClone(fixture), protocolVersion: 2 };
    const result = parseOpenEdgeDbObserverV2Output(JSON.stringify(legacy));
    assert.equal(
      result.metrics.filter(
        (m) => m.name === "table_operations_total" && m.labels.operation === "read"
      ).length,
      64
    );
    assert.equal(
      result.metrics.some((m) => m.labels.table === "Table0069"),
      false
    );
  });
});
