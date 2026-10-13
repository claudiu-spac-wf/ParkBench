import assert from "node:assert/strict";
import { it, afterEach } from "node:test";
import { normalizeOpenEdgeDbCollectorSnapshot } from "../../packages/observers/src/openedge-db/snapshot";
import { parseOpenEdgeDbObserverOutput } from "../../packages/observers/src/openedge-db/adapter";
import { setOpenEdgeDbLabelSet } from "../../packages/contracts/src/openedge";
afterEach(() => setOpenEdgeDbLabelSet(undefined));
function normalize(active = 10, capacity = 100, alternate = 0, rows?: any[], allocation?: any[]) {
  return normalizeOpenEdgeDbCollectorSnapshot({
    protocolVersion: 3,
    labels: { tables: [], indexes: [] },
    database: {
      productVersion: "12.8.11.1",
      startedAt: "2026-10-02T00:00:00Z",
      statisticsResetAt: "2026-10-02T00:00:00Z"
    },
    collectedAt: "2026-10-02T00:01:00Z",
    snapshot: {
      ...(allocation ? { _BuffStatus: allocation } : {}),
      _DbParams: [
        { parameter: "-B", "_DbParams-Value": capacity },
        { parameter: "-B2", "_DbParams-Value": alternate }
      ],
      _ActBuffer: rows ?? [
        {
          pool: "primary",
          "_Buffer-Active": active,
          "_Buffer-Free": 0,
          "_Buffer-LogicRds": 1000,
          "_Buffer-OSRds": 100
        },
        {
          pool: "alternate",
          "_Buffer-Active": 0,
          "_Buffer-Free": 0,
          "_Buffer-LogicRds": 0,
          "_Buffer-OSRds": 0
        }
      ]
    }
  });
}
it("publishes unused configured capacity independently of the raw free list", () => {
  const result = normalize();
  assert.equal(
    result.metrics.find((m) => m.name === "buffer_pool_free_buffers" && m.labels.pool === "primary")
      ?.value,
    90
  );
  assert.equal(
    result.metrics.find(
      (m) => m.name === "buffer_pool_free_list_buffers" && m.labels.pool === "primary"
    )?.value,
    0
  );
  assert.equal(
    result.metrics.find(
      (m) => m.name === "buffer_pool_cumulative_cache_hit_ratio" && m.labels.pool === "primary"
    )?.value,
    0.9
  );
  assert.equal(
    result.metrics.some((m) => m.labels.pool === "alternate"),
    false
  );
});
it("marks contradictory/disabled pool capacity unavailable rather than inventing a zero", () => {
  for (const [active, capacity] of [
    [101, 100],
    [-1, 100],
    [0, 0]
  ]) {
    const result = normalize(active, capacity);
    assert.equal(
      result.metrics.some((m) => m.name === "buffer_pool_free_buffers"),
      false
    );
    const primary = result.families
      .flatMap((f) => f.measurements)
      .find((m) => m.name === "buffer_pool_free_buffers" && m.labels?.pool === "primary");
    assert.notEqual(primary?.availability, "available");
  }
  assert.equal(
    normalize(100, 100).metrics.find((m) => m.name === "buffer_pool_free_buffers")?.value,
    0
  );
});
it("does not treat aggregate rows or contradictory duplicate pool observations as capacity", () => {
  const aggregate = { pool: "all", "_Buffer-Active": 99, "_Buffer-Free": 0 };
  const primary = {
    pool: "primary",
    "_Buffer-Active": 10,
    "_Buffer-Free": 0,
    "_Buffer-LogicRds": 1000,
    "_Buffer-OSRds": 100
  };
  const valid = normalize(10, 100, 0, [aggregate, primary]);
  assert.equal(valid.metrics.find((m) => m.name === "buffer_pool_free_buffers")?.value, 90);
  const conflict = normalize(10, 100, 0, [primary, { ...primary, "_Buffer-Active": 11 }]);
  assert.equal(
    conflict.metrics.some((m) => m.name === "buffer_pool_free_buffers"),
    false
  );
});

it("uses same-snapshot allocated capacity including reserved primary buffers", () => {
  const result = normalize(3002, 3000, 100, undefined, [{ "_BfStatus-TotBufs": 3102 }]);
  parseOpenEdgeDbObserverOutput(JSON.stringify(result));
  assert.equal(
    result.metrics.find(
      (m) => m.name === "buffer_pool_configured_buffers" && m.labels.pool === "primary"
    )?.value,
    3002
  );
  assert.equal(
    result.metrics.find(
      (m) => m.name === "buffer_pool_active_buffers" && m.labels.pool === "primary"
    )?.value,
    3002
  );
  assert.equal(
    result.metrics.find((m) => m.name === "buffer_pool_free_buffers" && m.labels.pool === "primary")
      ?.value,
    0
  );
  assert.equal(
    result.metrics.find(
      (m) => m.name === "buffer_pool_configured_buffers" && m.labels.pool === "alternate"
    )?.value,
    100
  );
  assert.equal(
    normalize(10, 100, 0, undefined, [{ "_BfStatus-TotBufs": 102 }]).metrics.find(
      (m) => m.name === "buffer_pool_free_buffers" && m.labels.pool === "primary"
    )?.value,
    92
  );
});
it("rejects conflicting, impossible and missing allocation evidence without clamping occupancy", () => {
  for (const allocation of [
    [{ "_BfStatus-TotBufs": 99 }],
    [{ "_BfStatus-TotBufs": 103 }],
    [{ "_BfStatus-TotBufs": 102 }, { "_BfStatus-TotBufs": 101 }]
  ]) {
    const result = normalize(102, 100, 0, undefined, allocation);
    assert.equal(
      result.metrics.some(
        (m) => m.name === "buffer_pool_free_buffers" && m.labels.pool === "primary"
      ),
      false
    );
  }
  assert.equal(
    normalize(103, 100, 0, undefined, [{ "_BfStatus-TotBufs": 102 }]).metrics.some(
      (m) => m.name === "buffer_pool_active_buffers" && m.labels.pool === "primary"
    ),
    false
  );
  assert.equal(
    normalize(102, 100).metrics.some(
      (m) => m.name === "buffer_pool_active_buffers" && m.labels.pool === "primary"
    ),
    false
  );
});

it("accepts historical source declarations while retaining strict source identity", () => {
  const result = normalize();
  for (const family of result.families)
    family.sources = family.sources.filter((source) => source !== "_BuffStatus");
  assert.doesNotThrow(() => parseOpenEdgeDbObserverOutput(JSON.stringify(result)));
  result.families.find((f) => f.name === "buffer_pool")!.sources.push("_ActLock");
  assert.throws(
    () => parseOpenEdgeDbObserverOutput(JSON.stringify(result)),
    /openedge_db_observer_contract_invalid/
  );
});
