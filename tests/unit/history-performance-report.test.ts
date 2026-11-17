import test from "node:test";
import assert from "node:assert/strict";
import {
  recordOperation,
  latchCategory,
  topLatchCategories,
  pairedBufferHits,
  appliedRunParameters
} from "../../apps/control-plane/src/reports/history-performance";
test("read POSTs stay reads, positive write work selects CRUD writes and disabled writes do not", () => {
  const read = {
    method: "POST",
    weight: 1,
    bodyTemplate: { procName: "Workloads/Generic/arbitrary_reads.p" }
  };
  assert.equal(recordOperation({ workload: { operations: [read] } }), "read");
  for (const write of [
    { weight: 1, bodyTemplate: { procName: "Workloads/Write/AuditLog.p" } },
    { weight: 1, bodyTemplate: { input: { Operation: "update" } } },
    { weight: 1, bodyTemplate: { input: { op: "audit-write-cycle" } } }
  ])
    assert.equal(recordOperation({ workload: { operations: [read, write] } }), "write");
  assert.equal(
    recordOperation({
      workload: {
        operations: [read, { weight: 0, bodyTemplate: { input: { Operation: "delete" } } }]
      }
    }),
    "read"
  );
  assert.throws(
    () =>
      recordOperation({
        workload: { operations: [{ weight: 1, bodyTemplate: { procName: "unknown" } }] }
      }),
    /unknown/
  );
});
test("numbered named latch instances combine once before top four ranking", () => {
  assert.equal(latchCategory("MTL_BF1"), "BFN");
  assert.equal(latchCategory("MTL_0"), "0");
  assert.equal(latchCategory("MTL_LHT12"), "LHTN");
  assert.equal(latchCategory("MTL_LHT"), "LHT");
  const rows = [1, 2, 3, 4].map((n) => ({ name: "MTL_BF" + n, waits: n, coverage: "complete" }));
  rows.push(
    { name: "MTL_MTX", waits: 8, coverage: "complete" },
    { name: "MTL_TXQ", waits: 7, coverage: "complete" },
    { name: "MTL_OM", waits: 6, coverage: "complete" },
    { name: "MTL_Z", waits: 5, coverage: "complete" }
  );
  assert.deepEqual(
    topLatchCategories(rows).map((r) => [r.category, r.waits]),
    [
      ["BFN", 10],
      ["MTX", 8],
      ["TXQ", 7],
      ["OM", 6]
    ]
  );
  assert.equal(
    topLatchCategories([
      { name: "BF1", waits: null, coverage: "unavailable" },
      { name: "BF2", waits: 0, coverage: "complete" }
    ])[0].coverage,
    "partial"
  );
  assert.deepEqual(topLatchCategories([{ name: "BF1", waits: null, coverage: "unavailable" }]), []);
});
test("pool hit ratios weight matched counter deltas and never bridge missing samples or epochs", () => {
  const weighted = pairedBufferHits(
    [
      {
        logical: [
          [0, 0],
          [10, 100],
          [20, 1000]
        ],
        physical: [
          [0, 0],
          [10, 0],
          [20, 90]
        ]
      }
    ],
    0,
    20,
    10
  );
  assert.equal(weighted.ratio, 0.91);
  const missing = pairedBufferHits(
    [
      {
        logical: [
          [0, 1000],
          [10, 1100],
          [20, 1200],
          [30, 1300],
          [40, 1400]
        ],
        physical: [
          [0, 200],
          [10, 210],
          [30, 230],
          [40, 240]
        ]
      }
    ],
    0,
    40,
    10
  );
  assert.equal(missing.ratio, 0.9);
  assert.equal(missing.logical, 200);
  assert.equal(missing.coverage, "partial");
  const epochs = pairedBufferHits(
    [
      {
        logical: [
          [0, 0],
          [10, 100]
        ],
        physical: [
          [0, 0],
          [10, 10]
        ]
      },
      {
        logical: [
          [20, 10000],
          [30, 10100]
        ],
        physical: [
          [20, 1000],
          [30, 1010]
        ]
      }
    ],
    0,
    30,
    10
  );
  assert.equal(epochs.logical, 200);
  assert.equal(epochs.ratio, 0.9);
  assert.equal(
    pairedBufferHits(
      [
        {
          logical: [
            [0, 0],
            [10, 0]
          ],
          physical: [
            [0, 0],
            [10, 0]
          ]
        }
      ],
      0,
      10,
      10
    ).ratio,
    null
  );
  assert.equal(pairedBufferHits([], 0, 10, 10).ratio, null);
});

test("applied parameters prefer captured values and verified controls, preserving unverified settings", () => {
  const run = {
    environmentSnapshot: {
      effectiveConfiguration: { "-B": 100, "-n": 200, "-bibufs": 1000, "-lruskips": 100 },
      databaseRunControlEvidence: {
        lastSuccessfulObservation: {
          biBuffers: 1000,
          apwCount: 2,
          biwCount: 1,
          nativeClusterKiB: 65536
        }
      }
    }
  };
  const value = appliedRunParameters(run, {
    status: "complete",
    rows: [
      { name: "-B", displayValue: "100", valueStatus: "recorded" },
      { name: "-B2", displayValue: "0", valueStatus: "recorded" },
      { name: "-n", displayValue: "201", valueStatus: "recorded" }
    ]
  });
  assert.match(value.text, /-n=201/);
  assert.match(value.text, /-B2=0/);
  assert.match(value.text, /-lruskips=100 \(configured\)/);
  assert.equal(value.text.match(/-bibufs=/g)?.length, 1);
  assert.deepEqual(value.unverified, ["-lruskips"]);
});
