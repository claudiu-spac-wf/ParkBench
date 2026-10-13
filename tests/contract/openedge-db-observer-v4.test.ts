import assert from "node:assert/strict";
import test from "node:test";
import { namedLatchSnapshot } from "../helpers/openedge-db-v4";
import { fixtureCollectorSnapshot } from "../helpers/openedge-db-v2";
import {
  parseOpenEdgeDbObserverOutput,
  OpenEdgeDatabaseObserverV3
} from "../../packages/observers/src/openedge-db/adapter";

test("v4 publishes exhaustive named zero/count/duration tuples and owned capture identity", async () => {
  const input = namedLatchSnapshot();
  const result: any = parseOpenEdgeDbObserverOutput(JSON.stringify(input));
  assert.equal(result.protocolVersion, 4);
  assert.equal(result.latchInventory.complete, true);
  assert.equal(result.latchInventory.instances.length, 3);
  assert.equal(result.latchInventory.capturedAt, result.collectedAt);
  assert.equal(result.latchInventory.database, "owned-db");
  assert.equal(result.latchInventory.runId, "owned-run");
  assert.equal(result.latchInventory.authoritativePublisher, "endpoint");
  const waits = result.metrics.filter((m: any) => m.name === "latch_named_waits_total");
  assert.deepEqual(
    waits.map((m: any) => m.value),
    [10, 30, 0]
  );
  assert.deepEqual(
    result.metrics
      .filter((m: any) => m.name === "latch_named_wait_or_spin_duration_seconds_total")
      .map((m: any) => m.value),
    [2, 5, 0]
  );
  assert.equal(waits[0].labels.latch_name, input.snapshot._Latch[0]["_Latch-Name"]);
  assert.equal(waits[0].labels.latch_id, "native-1");
  assert.equal(result.metrics.find((m: any) => m.name === "latch_waits_total").value, 40);
  const samples = await new OpenEdgeDatabaseObserverV3(async () => result).sample({
    runId: "owned-run",
    experimentId: "owned-experiment",
    variantId: "v",
    repetition: 1,
    phase: "measurement"
  });
  const named = samples.filter(
    (m) => m.metricName === "parkbench_openedge_db_latch_named_waits_total"
  );
  assert.equal(named.length, 3);
  assert.ok(named.every((m) => m.labels.run_id === "owned-run" && m.labels.database_epoch));
  await assert.rejects(
    new OpenEdgeDatabaseObserverV3(async () => result).sample({
      runId: "foreign-run",
      experimentId: "owned-experiment",
      variantId: "v",
      repetition: 1,
      phase: "measurement"
    }),
    /inventory_owner/
  );
});

test("v4 rejects missing or dishonest inventory, unsafe counters and unbounded native identities", () => {
  for (const change of [
    (p: any) => delete p.latchInventory,
    (p: any) => delete p.database.name,
    (p: any) => (p.latchInventory.complete = false),
    (p: any) => (p.latchInventory.count = 4),
    (p: any) => (p.snapshot._Latch[0]["_Latch-Name"] = ""),
    (p: any) => (p.snapshot._Latch[0]["_Latch-Type"] = "x".repeat(257)),
    (p: any) => (p.snapshot._Latch[0].latch_id = ""),
    (p: any) => (p.snapshot._Latch[0]["_Latch-Wait"] = Number.MAX_SAFE_INTEGER + 1),
    (p: any) => (p.snapshot._Latch[0]["_Latch-Wait"] = 0.5),
    (p: any) => (p.snapshot._Latch[0]["_Latch-Wait"] = -1),
    (p: any) => p.snapshot._Latch.push({ ...p.snapshot._Latch[0] }),
    (p: any) => {
      p.snapshot._Latch = Array.from({ length: 513 }, (_, i) => ({
        ...p.snapshot._Latch[0],
        latch_id: String(i)
      }));
      p.latchInventory.count = 513;
    }
  ]) {
    const input = namedLatchSnapshot();
    change(input);
    assert.throws(() => parseOpenEdgeDbObserverOutput(JSON.stringify(input)), /contract_invalid/);
  }
});

test("v4 normalized payload cannot borrow another tuple or capture's availability", () => {
  const valid: any = parseOpenEdgeDbObserverOutput(JSON.stringify(namedLatchSnapshot()));
  for (const change of [
    (p: any) => delete p.latchInventory,
    (p: any) => p.latchInventory.instances.pop(),
    (p: any) => (p.latchInventory.capturedAt = "2026-01-01T00:00:00Z"),
    (p: any) => (p.latchInventory.databaseEpoch = "foreign-epoch"),
    (p: any) => (p.latchInventory.database = "foreign-db"),
    (p: any) =>
      (p.metrics.find((m: any) => m.name === "latch_named_waits_total").labels.latch_id =
        "foreign-instance"),
    (p: any) =>
      p.families
        .find((f: any) => f.name === "latch")
        .measurements.splice(
          p.families
            .find((f: any) => f.name === "latch")
            .measurements.findIndex((m: any) => m.name === "latch_named_waits_total"),
          1
        )
  ]) {
    const p = structuredClone(valid);
    change(p);
    assert.throws(() => parseOpenEdgeDbObserverOutput(JSON.stringify(p)), /contract_invalid/);
  }
});

test("unsupported optional duration does not replace valid named waits with zero or invalidate legacy captures", () => {
  const input = namedLatchSnapshot();
  delete input.snapshot._Latch[0]["_Latch-WaitT"];
  const result = parseOpenEdgeDbObserverOutput(JSON.stringify(input));
  assert.equal(
    result.metrics.some(
      (m) =>
        m.name === "latch_named_wait_or_spin_duration_seconds_total" &&
        m.labels.latch_id === "native-1"
    ),
    false
  );
  const availability = result.families
    .flatMap((f) => f.measurements)
    .find(
      (m) =>
        m.name === "latch_named_wait_or_spin_duration_seconds_total" &&
        m.labels?.latch_id === "native-1"
    );
  assert.equal(availability?.availability, "unsupported");
  assert.equal(availability?.reason, "field_missing");
  for (const version of [2, 3]) {
    const legacy = fixtureCollectorSnapshot();
    legacy.protocolVersion = version;
    legacy.labels = { tables: [], indexes: [] };
    const p = parseOpenEdgeDbObserverOutput(JSON.stringify(legacy));
    assert.equal(p.protocolVersion, version);
    assert.equal(
      p.metrics.some((m) => m.name.startsWith("latch_named_")),
      false
    );
  }
});

test("v4 preserves all six aggregate meanings separately from named counters", () => {
  const raw = namedLatchSnapshot();
  raw.snapshot._Latch.forEach((row: any, index: number) =>
    Object.assign(row, {
      "_Latch-Busy": index + 1,
      "_Latch-Lock": (index + 1) * 10,
      "_Latch-Spin": (index + 1) * 100,
      "_Latch-LockT": (index + 1) * 1000000
    })
  );
  const v4 = parseOpenEdgeDbObserverOutput(JSON.stringify(raw));
  raw.protocolVersion = 3;
  delete raw.database.name;
  delete raw.latchInventory;
  const legacy = parseOpenEdgeDbObserverOutput(JSON.stringify(raw));
  const aggregates = (p: any) =>
    p.metrics.filter((m: any) => m.name.startsWith("latch_") && !m.name.startsWith("latch_named_"));
  assert.equal(aggregates(legacy).length, 6);
  assert.deepEqual(aggregates(v4), aggregates(legacy));
});

test("v4 accepts the 512-instance/string boundary and rejects oversized family/output evidence", () => {
  const raw = namedLatchSnapshot();
  raw.snapshot._Latch = Array.from({ length: 512 }, (_, i) => ({
    ...raw.snapshot._Latch[0],
    latch_id: String(i),
    "_Latch-Name": "n".repeat(256),
    "_Latch-Type": "t".repeat(256)
  }));
  raw.latchInventory.count = 512;
  const valid: any = parseOpenEdgeDbObserverOutput(JSON.stringify(raw));
  assert.equal(valid.latchInventory.instances.length, 512);
  valid.families[0].measurements = Array.from(
    { length: 8193 },
    () => valid.families[0].measurements[0]
  );
  assert.throws(
    () => parseOpenEdgeDbObserverOutput(JSON.stringify(valid)),
    /contract_invalid:.*(?:cardinality|measurements)/
  );
  assert.throws(
    () => parseOpenEdgeDbObserverOutput(" ".repeat(8 * 1024 * 1024) + "{}"),
    /collection_bytes_exceeded/
  );
});
