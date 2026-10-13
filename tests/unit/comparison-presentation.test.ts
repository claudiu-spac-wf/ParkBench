import assert from "node:assert/strict";
import { it } from "node:test";
import {
  isResourceRowVisible,
  isDatabaseRowVisible,
  projectScheduledParameters,
  formatPercentageChange,
  baselineBadge
} from "../../apps/web/src/features/comparison/comparisonPresentation";
import type { ComparisonRow, ComparisonRunResult } from "../../packages/contracts/src/comparison";
import type { BaselineQualitySnapshot } from "../../apps/web/src/features/comparison/comparisonApi";

function eligibleRun(runId = "variant"): ComparisonRunResult {
  return {
    runId,
    experimentId: "experiment",
    role: runId === "baseline" ? "BASELINE" : "VARIANT",
    state: "SUCCEEDED",
    measurementValidity: "VALID",
    summary: {
      status: "READY",
      attemptToken: "attempt",
      header: {
        generatedAt: "2026-10-02T00:00:00Z",
        metricDefinitionsVersion: "v1",
        quality: { complete: true }
      }
    },
    rows: [],
    tablePage: { hasMore: false, returnedRowCount: 0, totalRowCount: 0 }
  } as unknown as ComparisonRunResult;
}
function badgeCase(
  percent = 25,
  group: "platform" | "database" | "pas" = "platform",
  definitionId = "cpu.usage"
) {
  const value = { value: 125, unit: "units", status: "available", reasons: [], coverage: {} };
  const row = {
    rowKey: "semantic-row",
    group,
    definitionId,
    dimensions: {},
    coverageScope: "native",
    rateOrLevelUnit: "units",
    totalUnit: null,
    statistics: { average: value }
  };
  return {
    statistic: "average" as const,
    run: eligibleRun(),
    baselineQuality: {
      status: "accepted",
      run: eligibleRun("baseline"),
      baselineRunId: "baseline",
      comparisonId: "cmp",
      selectionRevision: 1,
      generation: 1
    } as BaselineQualitySnapshot,
    comparisonRow: {
      row,
      baselineRow: { ...row, statistics: { average: { ...value, value: 100 } } },
      differences: {
        average: {
          value: 125,
          baseline: 100,
          absoluteDifference: 25,
          percentageDifference: percent
        }
      }
    } as ComparisonRow
  };
}

it("formats server percentage direction, decimal halfway rounding and signed subprecision bounds", () => {
  for (const [value, text] of [
    [0, "↔ 0%"],
    [-0, "↔ 0%"],
    [0.004, "↑ +<0.01%"],
    [-0.004, "↓ -<0.01%"],
    [0.01, "↑ +0.01%"],
    [-0.01, "↓ -0.01%"],
    [1.235, "↑ +1.24%"],
    [-1.235, "↓ -1.24%"],
    [1.005, "↑ +1.01%"],
    [-1.005, "↓ -1.01%"],
    [25, "↑ +25.00%"]
  ] as Array<[number, string]>)
    assert.equal(formatPercentageChange(value), text);
});

it("colors lower resource and database I/O changes as improvement, independent of numeric arrow", () => {
  for (const [group, definitionId] of [
    ["platform", "cpu.usage"],
    ["platform", "memory.used"],
    ["database", "cpu.usage"],
    ["database", "memory.used"],
    ["database", "disk.read.operations"],
    ["database", "disk.write.operations"],
    ["pas", "cpu.usage"],
    ["database", "db.buffer.logical.read"],
    ["database", "db.buffer.logical.write"],
    ["database", "db.blocks.read"],
    ["database", "db.blocks.write"]
  ] as Array<["platform" | "database" | "pas", string]>) {
    assert.deepEqual(baselineBadge(badgeCase(-0.004, group, definitionId)).badge, {
      text: "↓ -<0.01%",
      tone: "improvement"
    });
    assert.deepEqual(baselineBadge(badgeCase(0.004, group, definitionId)).badge, {
      text: "↑ +<0.01%",
      tone: "deterioration"
    });
  }
});

it("colors higher record read/combined write changes as improvement and exact zero as neutral", () => {
  for (const id of ["db.records.read", "db.records.write"]) {
    assert.equal(baselineBadge(badgeCase(25, "database", id)).badge?.tone, "improvement");
    assert.equal(baselineBadge(badgeCase(-25, "database", id)).badge?.tone, "deterioration");
  }
  for (const value of [0, -0])
    assert.deepEqual(baselineBadge(badgeCase(value)).badge, { text: "↔ 0%", tone: "neutral" });
  const self = badgeCase();
  self.run.role = "BASELINE";
  assert.deepEqual(baselineBadge(self), {});
});

it("uses the server percentage unchanged rather than deriving it from displayed values", () => {
  const value = badgeCase(1.235);
  assert.equal(baselineBadge(value).badge?.text, "↑ +1.24%");
});

it("withholds numeric changes with server reasons, zero/missing statistics or nonfinite data", () => {
  const unavailable = (value: ReturnType<typeof badgeCase>) => {
    const projected = baselineBadge(value);
    assert.equal(projected.badge, undefined);
    assert.ok(projected.reason);
  };
  let value = badgeCase();
  value.comparisonRow.differences.average.reason = "statistic_semantics_mismatch";
  assert.equal(baselineBadge(value).reason, "statistic_semantics_mismatch");
  value = badgeCase();
  value.comparisonRow.baselineRow.statistics.average.value = 0;
  unavailable(value);
  value = badgeCase();
  value.comparisonRow.row.statistics.average.value = null;
  unavailable(value);
  value = badgeCase();
  delete value.comparisonRow.baselineRow.statistics.average;
  unavailable(value);
  value = badgeCase();
  delete value.comparisonRow.baselineRow;
  unavailable(value);
  for (const percentage of [NaN, Infinity, -Infinity, null]) {
    value = badgeCase();
    value.comparisonRow.differences.average.percentageDifference = percentage;
    unavailable(value);
  }
  value = badgeCase();
  value.comparisonRow.row.statistics.average.value = Infinity;
  unavailable(value);
});

it("withholds changes for semantically mismatched rows or statistic units", () => {
  for (const field of [
    "rowKey",
    "definitionId",
    "group",
    "coverageScope",
    "rateOrLevelUnit",
    "totalUnit"
  ] as const) {
    const value = badgeCase();
    (value.comparisonRow.baselineRow as any)[field] = "mismatched";
    assert.equal(baselineBadge(value).badge, undefined, field);
  }
  let value = badgeCase();
  value.comparisonRow.baselineRow.dimensions = { pool: "alternate" };
  assert.equal(baselineBadge(value).badge, undefined);
  value = badgeCase();
  value.comparisonRow.baselineRow.statistics.average.unit = "bytes";
  assert.equal(baselineBadge(value).badge, undefined);
});

it("keeps quality warnings alongside badges but guards unavailable source identities", () => {
  for (const baseline of [true, false])
    for (const mutate of [
      (run: ComparisonRunResult) => {
        run.state = "FAILED";
      },
      (run: ComparisonRunResult) => {
        run.measurementValidity = "INCOMPLETE";
      },
      (run: ComparisonRunResult) => {
        run.summary.header.quality.complete = false;
      }
    ]) {
      const value = badgeCase();
      mutate(baseline ? value.baselineQuality.run : value.run);
      const projected = baselineBadge(value);
      assert.ok(projected.badge);
      assert.match(projected.warning ?? "", /incomplete/);
    }
  const value = badgeCase();
  value.baselineQuality.status = "pending";
  value.baselineQuality.sourceStatus = "pending";
  assert.equal(baselineBadge(value).badge, undefined);
});

it("withholds stale or unknown baseline observations with explicit local reasons", () => {
  for (const status of ["pending", "unavailable"] as const) {
    const value = badgeCase();
    value.baselineQuality.status = status;
    value.baselineQuality.reason = "Baseline observation changed. Retry comparison.";
    assert.deepEqual(baselineBadge(value), { reason: value.baselineQuality.reason });
  }
  const value = badgeCase();
  value.baselineQuality.run.runId = "wrong-baseline";
  assert.equal(baselineBadge(value).badge, undefined);
  assert.ok(baselineBadge({ ...badgeCase(), baselineQuality: undefined }).reason);
});

const metric = (group: "platform" | "database" | "pas", definitionId: string, dimensions = {}) => ({
  group,
  definitionId,
  dimensions
});
const startup = (parameters: unknown[]) => ({
  contractVersion: "db-startup-parameters.v1",
  databaseName: "scheduled-db",
  startupFile: { status: "absent" },
  parameters
});
const project = (parameters: unknown, databaseStartup: unknown) =>
  projectScheduledParameters({ requestedConfiguration: { parameters, databaseStartup } });

it("selects resource definitions by both group and definition ID", () => {
  const ids = [
    "cpu.usage",
    "memory.used",
    "disk.read.operations",
    "disk.write.operations",
    "disk.read.bytes",
    "disk.write.bytes",
    "network.received.bytes",
    "cpu.time",
    "db.records.read"
  ];
  for (const group of ["platform", "database", "pas"] as const) {
    const expected =
      group === "database"
        ? ["cpu.usage", "memory.used", "disk.read.operations", "disk.write.operations"]
        : group === "platform"
          ? ["cpu.usage", "memory.used"]
          : ["cpu.usage"];
    assert.deepEqual(
      ids.filter((id) => isResourceRowVisible(metric(group, id))),
      expected
    );
  }
});

it("selects database-wide records, logical pools and physical blocks without table rows", () => {
  const ids = [
    "db.records.read",
    "db.records.write",
    "db.buffer.logical.read",
    "db.buffer.logical.write",
    "db.blocks.read",
    "db.blocks.write",
    "db.records.create",
    "db.records.update",
    "db.records.delete",
    "db.transactions",
    "db.bi.write",
    "db.buffer.physical.read",
    "db.buffer.physical.write"
  ];
  assert.deepEqual(
    ids.filter((id) => isDatabaseRowVisible(metric("database", id))),
    ids.slice(0, 6)
  );
  assert.equal(isDatabaseRowVisible(metric("platform", "db.records.read")), false);
  for (const pool of ["primary", "alternate"]) {
    assert.equal(
      isDatabaseRowVisible(metric("database", "db.buffer.logical.read", { pool })),
      true
    );
    assert.equal(
      isDatabaseRowVisible(metric("database", "db.buffer.logical.write", { pool })),
      true
    );
  }
  assert.equal(
    isDatabaseRowVisible(metric("database", "db.records.read", { table: "Customer" })),
    false
  );
  assert.equal(isDatabaseRowVisible(metric("database", "db.records.write", { table: "" })), false);
});

it("projects scheduled maps and structured startup values without observed replacements or metadata", () => {
  const result = project(
    { zero: 0, disabled: false, empty: "", object: { size: 2 }, list: [1, 2] },
    startup([{ name: "-B", displayValue: "32", observedValue: "64", verification: "mismatched" }])
  );
  assert.equal(result.status, "populated");
  assert.deepEqual(result.unavailableSources, []);
  assert.deepEqual(result.entries, [
    { name: "zero", value: "0", sources: ["Ordinary parameters"] },
    { name: "disabled", value: "false", sources: ["Ordinary parameters"] },
    { name: "empty", value: "", sources: ["Ordinary parameters"] },
    { name: "object", value: '{"size":2}', sources: ["Ordinary parameters"] },
    { name: "list", value: "[1,2]", sources: ["Ordinary parameters"] },
    { name: "-B", value: "32", sources: ["Database startup"] }
  ]);
});

it("coalesces equal scheduled name/value pairs and retains conflicting source values", () => {
  const result = project(
    { "-B": 32, conflict: "ordinary" },
    startup([
      { name: "-B", displayValue: "32" },
      { name: "conflict", displayValue: "startup" }
    ])
  );
  assert.deepEqual(result.entries, [
    { name: "-B", value: "32", sources: ["Ordinary parameters", "Database startup"] },
    { name: "conflict", value: "ordinary", sources: ["Ordinary parameters"] },
    { name: "conflict", value: "startup", sources: ["Database startup"] }
  ]);
});

it("recognizes ordinary empty maps and both known-empty startup representations", () => {
  for (const source of [{}, startup([])]) {
    assert.deepEqual(project({}, source), { entries: [], status: "empty", unavailableSources: [] });
  }
});

it("does not label absent, null or malformed sources as None set", () => {
  for (const source of [undefined, null, [], "bad"]) {
    const result = project(source, {});
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.unavailableSources, ["Ordinary parameters"]);
  }
  for (const source of [
    undefined,
    null,
    [],
    "bad",
    { databaseName: "metadata only" },
    { parameters: {} }
  ]) {
    const result = project({}, source);
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.unavailableSources, ["Database startup"]);
  }
  assert.equal(projectScheduledParameters(undefined).status, "unavailable");
});

it("preserves valid entries and identifies malformed remainder of each source", () => {
  const result = project(
    { good: 0, bad: undefined },
    startup([
      { name: "-B", displayValue: "32" },
      { name: "missing" },
      null,
      { name: "", displayValue: "bad" },
      { name: "observedOnly", observedValue: "64" }
    ])
  );
  assert.equal(result.status, "partial");
  assert.deepEqual(result.unavailableSources, ["Ordinary parameters", "Database startup"]);
  assert.deepEqual(
    result.entries.map((entry) => [entry.name, entry.value]),
    [
      ["good", "0"],
      ["-B", "32"]
    ]
  );
});

it("uses historical saved sources only when requestedConfiguration is absent", () => {
  const snapshot = {
    variant: {
      parameters: { historical: "saved" },
      databaseStartup: startup([{ name: "-B", displayValue: "16" }])
    },
    databaseStartup: startup([{ name: "-B", displayValue: "32" }])
  };
  assert.deepEqual(
    projectScheduledParameters(snapshot).entries.map((entry) => [entry.name, entry.value]),
    [
      ["historical", "saved"],
      ["-B", "32"]
    ]
  );
  const withoutTop = { variant: snapshot.variant };
  assert.equal(projectScheduledParameters(withoutTop).entries[1].value, "16");
  const preferred = projectScheduledParameters({
    ...snapshot,
    requestedConfiguration: { parameters: { preferred: "saved" } }
  });
  assert.equal(preferred.status, "partial");
  assert.deepEqual(
    preferred.entries.map((entry) => entry.name),
    ["preferred"]
  );
  assert.deepEqual(preferred.unavailableSources, ["Database startup"]);
});

it("does not fill malformed preferred or explicit null historical startup from fallbacks", () => {
  const variant = {
    parameters: { fallback: "must not appear" },
    databaseStartup: startup([{ name: "-B", displayValue: "16" }])
  };
  for (const requestedConfiguration of [null, [], "bad", {}]) {
    const result = projectScheduledParameters({ requestedConfiguration, variant });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.entries, []);
  }
  assert.equal(projectScheduledParameters({ variant, databaseStartup: null }).status, "partial");
});

it("shows +20% with an incomplete baseline warning for retained 100 and 120 values", () => {
  const input = badgeCase(20);
  input.comparisonRow.row.statistics.average.value = 120;
  input.baselineQuality.status = "unavailable";
  input.baselineQuality.sourceStatus = "stable";
  input.baselineQuality.run.summary.header.quality.complete = false;
  const result = baselineBadge(input);
  assert.equal(result.badge?.text, "↑ +20.00%");
  assert.match(result.warning ?? "", /Baseline measurements are incomplete/);
  assert.equal(result.reason, undefined);
  input.baselineQuality.sourceStatus = "unavailable";
  assert.equal(baselineBadge(input).badge, undefined);
});

it("shows an available unknown-direction percentage in a neutral badge", () => {
  const value = badgeCase(20, "platform", "unknown.recorded.metric");
  assert.equal(baselineBadge(value).badge?.tone, "neutral");
});
