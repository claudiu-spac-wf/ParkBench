import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalNativeSeries,
  nativeDescriptor,
  nativePhaseWindows
} from "../../apps/control-plane/src/grafana/native-diagnostics";
import { counterWindow } from "../../apps/control-plane/src/grafana/native-counter-window";
import { scanSelectors } from "../../apps/control-plane/src/grafana/promql-selectors";
import { nativeDiagnosticExpression } from "../../packages/dashboards/src/queries/diagnostic";

const timeline: any = {
  runId: "named-run",
  startedAt: 0,
  endedAt: 16000,
  continuousMetrics: true,
  nativePublisher: "endpoint",
  phases: [
    { phase: "warmup", start: 0, end: 5000 },
    { phase: "measurement", start: 5000, end: 15000 },
    { phase: "cooldown", start: 15000, end: 16000 }
  ]
};
const metric = {
  __name__: "parkbench_openedge_db_latch_named_waits_total",
  run_id: "named-run",
  database: "owned-db",
  database_epoch: "epoch-a",
  service: "database",
  job: "parkbench-runs",
  latch_name: "buffer",
  latch_type: "shared",
  latch_id: "1"
};

test("native latch instance, type and epoch survive canonicalization before name reduction", () => {
  const values: Array<[number, number]> = [
    [5, 100],
    [10, 105],
    [15, 110]
  ];
  const input = [
    { metric, values },
    {
      metric: { ...metric, latch_name: "transaction", latch_id: "2" },
      values: [
        [5, 100],
        [10, 115],
        [15, 130]
      ] as Array<[number, number]>
    },
    {
      metric: { ...metric, latch_name: "idle", latch_id: "3" },
      values: [
        [5, 0],
        [10, 0],
        [15, 0]
      ] as Array<[number, number]>
    }
  ];
  const canonical = canonicalNativeSeries(
    [
      ...input,
      ...input,
      { metric: { ...metric, job: "parkbench-control-plane" }, values: [[10, 9999]] }
    ],
    [timeline]
  );
  assert.equal(canonical.length, 3);
  assert.deepEqual(
    canonical.map((s) => counterWindow(s.values, 5, 15, 5)?.increase),
    [10, 30, 0]
  );
  const distinct = canonicalNativeSeries(
    [
      { metric, values },
      { metric: { ...metric, latch_id: "4" }, values },
      { metric: { ...metric, database_epoch: "epoch-b" }, values },
      { metric: { ...metric, latch_type: "exclusive" }, values }
    ],
    [timeline]
  );
  assert.equal(
    distinct.length,
    4,
    "same-name instances, types and epochs cannot be summed before deltas"
  );
});

test("named windows exclude warmup, handle counter resets and retain unavailable gaps", () => {
  assert.deepEqual(nativePhaseWindows(timeline, 0, 16000, "measurement", 16000), [
    { start: 5, end: 15 }
  ]);
  assert.equal(
    counterWindow(
      [
        [0, 9999],
        [5, 100],
        [10, 105],
        [15, 110]
      ],
      5,
      15,
      5
    )?.increase,
    10
  );
  assert.equal(
    counterWindow(
      [
        [5, 100],
        [10, 2],
        [15, 7]
      ],
      5,
      15,
      5
    )?.increase,
    7
  );
  assert.equal(
    counterWindow(
      [
        [5, 100],
        [10, null],
        [15, 110]
      ],
      5,
      15,
      5
    ),
    null
  );
});

test("named diagnostic filters preserve literal names without adding arbitrary query labels", () => {
  const literal = 'buffer"pool\\lock';
  const expression = nativeDiagnosticExpression("latch_named_waits_total", "total", {
    latch_name: { value: literal, operator: "=" } as any,
    latch_type: "shared"
  });
  const selectors = scanSelectors(
    expression
      .replace("$run_id", "named-run")
      .replace("$phase", "measurement")
      .replace("$__from", "5000")
      .replace("$__to", "15000")
  );
  const descriptor = nativeDescriptor(selectors[0].matchers);
  assert.equal(descriptor.filters.find((f) => f.name === "latch_name")?.value, literal);
  assert.equal(descriptor.filters.find((f) => f.name === "latch_name")?.op, "=");
  assert.throws(
    () =>
      nativeDescriptor([
        ...selectors[0].matchers,
        { name: "arbitrary", op: "=", value: "x", start: 0, end: 0 }
      ]),
    /filter_invalid/
  );
});

test("named query availability joins exact tuple, epoch, run, publisher and capture", async () => {
  const { joinNamedLatchAvailability } =
    await import("../../apps/control-plane/src/grafana/native-diagnostics");
  const base: any = {
    metric,
    values: [
      [5, 0],
      [10, 10]
    ]
  };
  const availability: any = {
    metric: {
      ...metric,
      __name__: "parkbench_openedge_db_metric_available",
      measurement: "latch_named_waits_total",
      reason: "available"
    },
    values: [
      [5, 1],
      [10, 1]
    ]
  };
  assert.deepEqual(
    joinNamedLatchAvailability([base, availability], [timeline])[0].values,
    base.values
  );
  for (const change of [
    { latch_id: "foreign" },
    { database_epoch: "foreign" },
    { run_id: "foreign" },
    { database: "foreign" },
    { job: "parkbench-control-plane" }
  ]) {
    assert.deepEqual(
      joinNamedLatchAvailability(
        [base, { ...availability, metric: { ...availability.metric, ...change } }],
        [timeline]
      )[0].values,
      [
        [5, null],
        [10, null]
      ]
    );
  }
  assert.deepEqual(
    joinNamedLatchAvailability(
      [
        base,
        {
          ...availability,
          values: [
            [5.1, 1],
            [10.1, 1]
          ]
        }
      ],
      [timeline]
    )[0].values,
    [
      [5, null],
      [10, null]
    ]
  );
});

test("per-name totals sum only instance/epoch reductions and preserve missing values", async () => {
  const { aggregateNamedLatchTotals } =
    await import("../../apps/control-plane/src/grafana/native-diagnostics");
  const first = { metric, value: [15, "10"] };
  const second = {
    metric: { ...metric, latch_id: "2", database_epoch: "epoch-b" },
    value: [15, "30"]
  };
  const aggregate = aggregateNamedLatchTotals([first, second]);
  assert.equal(aggregate.length, 1);
  assert.deepEqual(aggregate[0].value, [15, "40"]);
  assert.equal(aggregate[0].metric.latch_id, undefined);
  assert.equal(aggregate[0].metric.database_epoch, undefined);
  assert.equal(
    (aggregate[0].metric as Record<string, string>).database_epochs,
    '["epoch-a","epoch-b"]'
  );
  assert.deepEqual(aggregateNamedLatchTotals([first, { ...second, value: [15, "NaN"] }])[0].value, [
    15,
    "NaN"
  ]);
  assert.equal(
    aggregateNamedLatchTotals([
      first,
      { ...second, metric: { ...second.metric, latch_type: "exclusive" } }
    ]).length,
    2
  );
});
