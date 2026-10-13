import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPENEDGE_DB_LABEL_INDEX_LIMIT,
  OPENEDGE_DB_LABEL_TABLE_LIMIT,
  openEdgeDbLabelSet,
  setOpenEdgeDbLabelSet
} from "../../packages/contracts/src/openedge";
import { normalizeOpenEdgeDbCollectorSnapshot } from "../../packages/observers/src/openedge-db/snapshot";

describe("run-scoped DB metric label sets", () => {
  it("takes the label sets the collector read from the run database, with other as the bounded bucket", () => {
    try {
      setOpenEdgeDbLabelSet(undefined);
      assert.deepEqual(openEdgeDbLabelSet(), { tables: ["other"], indexes: ["other"] });
      normalizeOpenEdgeDbCollectorSnapshot({
        protocolVersion: 2,
        database: {
          productVersion: "12.8.11",
          startedAt: "2026-09-30T00:00:00Z",
          statisticsResetAt: "2026-09-30T00:00:00Z"
        },
        collectedAt: "2026-09-30T00:00:00.000Z",
        snapshot: {},
        labels: { tables: ["DebitTransaction", "AuditLog"], indexes: ["AuditLog.PkAuditLog"] }
      });
      assert.deepEqual(openEdgeDbLabelSet(), {
        tables: ["DebitTransaction", "AuditLog", "other"],
        indexes: ["AuditLog.PkAuditLog", "other"]
      });
    } finally {
      setOpenEdgeDbLabelSet(undefined);
    }
  });

  it("retains every table, caps indexes and drops duplicates", () => {
    try {
      setOpenEdgeDbLabelSet({
        tables: ["A", "A", "other", ...Array.from({ length: 70 }, (_, i) => `T${i}`)],
        indexes: Array.from({ length: 300 }, (_, i) => `T.I${i}`)
      });
      const labels = openEdgeDbLabelSet();
      assert.equal(labels.tables.length, 72);
      assert.deepEqual(labels.tables.slice(0, 2), ["A", "T0"]);
      assert.equal(labels.tables.at(-1), "other");
      assert.equal(labels.indexes.length, OPENEDGE_DB_LABEL_INDEX_LIMIT + 1);
    } finally {
      setOpenEdgeDbLabelSet(undefined);
    }
  });
});
