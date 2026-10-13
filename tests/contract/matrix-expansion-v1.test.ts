import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandMatrix, normalizeRunName, resolveDatabaseStartup, validateMatrixRequest } from "../../packages/contracts/src/matrix-expansion";
import { PLATFORM_RUN_PARAMETER_DEFINITIONS } from "../../packages/contracts/src/run-parameters";
import { DatabaseParameterDefinition } from "../../packages/contracts/src";

const definitions: DatabaseParameterDefinition[] = [
  {
    id: "b",
    canonicalName: "-B",
    type: "integer",
    minimum: 1,
    maximum: 10000,
    description: "block size",
    source: "test",
    matrixAllowed: true,
    secret: false,
    definitionVersion: "1"
  },
  {
    id: "b2",
    canonicalName: "-B2",
    type: "integer",
    minimum: 1,
    maximum: 10000,
    description: "block size 2",
    source: "test",
    matrixAllowed: true,
    secret: false,
    definitionVersion: "1"
  }
];

describe("matrix-expansion.v1", () => {
  it("requires and normalizes a user supplied run name in the preview identity", () => {
    assert.throws(() => normalizeRunName("  "), /run_name_required/);
    assert.throws(() => normalizeRunName("bad/name"), /run_name_invalid/);
    assert.equal(normalizeRunName(" DB_Cache "), "db-cache");
    const request = { runName: "db-cache", scenario: { id: "s", version: "1" }, dimensions: [{ name: "-B", values: [500] }], repetitions: 1 };
    assert.throws(() => validateMatrixRequest({ ...request, runName: "" }, definitions), /run_name_required/);
  });
  it("expands the 4x4 matrix in deterministic order", () => {
    const cells = expandMatrix(
      {
        runName: "test-run",
        scenario: { id: "s", version: "1" },
        dimensions: [
          { name: "-B", values: [500, 1000, 1500, 2000] },
          { name: "-B2", values: [500, 1000, 1500, 2000] }
        ],
        repetitions: 1
      },
      definitions
    );
    assert.equal(cells.length, 16);
    assert.deepEqual(cells[0].values, { "-B": 500, "-B2": 500 });
    assert.deepEqual(cells[1].values, { "-B": 500, "-B2": 1000 });
    assert.equal(new Set(cells.map((cell) => JSON.stringify(cell.values))).size, 16);
  });
  it("rejects duplicate and conflicting dimensions", () => {
    assert.throws(
      () =>
        validateMatrixRequest(
          {
            runName: "test-run",
        scenario: { id: "s", version: "1" },
            dimensions: [{ name: "-B", values: [1, 1] }],
            repetitions: 1
          },
          definitions
        ),
      /duplicate_matrix_value/
    );
    assert.throws(
      () =>
        validateMatrixRequest(
          {
            runName: "test-run",
        scenario: { id: "s", version: "1" },
            dimensions: [{ name: "-B", values: [1] }],
            fixedOverrides: { "-B": 2 },
            repetitions: 1
          },
          definitions
        ),
      /matrix_override_conflict/
    );
  });

  it("evaluates typed dependency rules against the effective matrix configuration", () => {
    const dependentDefinitions = [
      { ...definitions[0], defaultValue: 10 },
      {
        ...definitions[1],
        defaultValue: 100,
        dependencies: [{ parameter: "-B", operator: "gte" as const, value: 5 }]
      }
    ];
    assert.doesNotThrow(() =>
      expandMatrix(
        {
          runName: "test-run",
        scenario: { id: "s", version: "1" },
          dimensions: [{ name: "-B2", values: [100] }],
          fixedOverrides: { "-B": 10 },
          repetitions: 1
        },
        dependentDefinitions
      )
    );
    assert.throws(
      () =>
        expandMatrix(
          {
            runName: "test-run",
        scenario: { id: "s", version: "1" },
            dimensions: [{ name: "-B2", values: [100] }],
            fixedOverrides: { "-B": 1 },
            repetitions: 1
          },
          dependentDefinitions
        ),
      /dependency_not_satisfied:-B2:-B/
    );
  });
});

describe("matrix-expansion.v1 Database Latency", () => {
  const withLatency = [...definitions, ...PLATFORM_RUN_PARAMETER_DEFINITIONS];
  const base = { runName: "latency", scenario: { id: "s", version: "1" }, repetitions: 1 };

  it("expands latency as a dimension and as a fixed override", () => {
    const cells = expandMatrix(
      { ...base, dimensions: [{ name: "network.databaseLatencyMs", values: [0, 5, 20] }] },
      withLatency
    );
    assert.deepEqual(
      cells.map((cell) => cell.effectiveConfiguration["network.databaseLatencyMs"]),
      [0, 5, 20]
    );
    const fixed = expandMatrix(
      {
        ...base,
        dimensions: [{ name: "-B", values: [500, 1000] }],
        fixedOverrides: { "network.databaseLatencyMs": 20 }
      },
      withLatency
    );
    assert.ok(fixed.every((cell) => cell.effectiveConfiguration["network.databaseLatencyMs"] === 20));
    const defaulted = expandMatrix({ ...base, dimensions: [{ name: "-B", values: [500] }] }, withLatency);
    assert.equal(defaulted[0].effectiveConfiguration["network.databaseLatencyMs"], 0);
  });

  it("rejects out-of-range values and dimension/override conflicts", () => {
    for (const value of [1001, 2.5, -1])
      assert.throws(() =>
        validateMatrixRequest(
          { ...base, dimensions: [{ name: "network.databaseLatencyMs", values: [value] }] },
          withLatency
        )
      );
    assert.throws(
      () =>
        validateMatrixRequest(
          {
            ...base,
            dimensions: [{ name: "network.databaseLatencyMs", values: [5] }],
            fixedOverrides: { "network.databaseLatencyMs": 20 }
          },
          withLatency
        ),
      /matrix_override_conflict/
    );
  });

  it("is never a database startup parameter", () => {
    const startup = resolveDatabaseStartup(
      { databaseName: "parkbench", startupFile: { status: "absent" }, entries: [] } as any,
      { "network.databaseLatencyMs": 0 },
      { "network.databaseLatencyMs": 20 },
      {}
    );
    assert.equal(startup.parameters.some((item) => item.name === "network.databaseLatencyMs"), false);
  });
});
