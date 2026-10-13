import assert from "node:assert/strict";
import test from "node:test";
import { expandMatrix, resolveDatabaseStartup } from "../../packages/contracts/src/matrix-expansion";
import { validateDatabaseStartupParameters } from "../../packages/contracts/src/database-startup";
import { legacyDatabaseParameterOptions as databaseParameterOptions, validateScheduledDatabaseParameter } from "../../packages/contracts/src/database-parameter-options-v1";
import { parameterPlan } from "../../packages/compose-runner/src/parameters";
import { validateScenarioDatabaseParameterDefinitions } from "../../apps/control-plane/src/catalog/scenario-validation";

const source = {
  startupFile: { status: "present" as const, relativePath: "startup.pf" as const },
  entries: [{ name: "-B", value: "500", line: 1 }]
};

test("queued > scenario > startup file with plaintext provenance", () => {
  const result = resolveDatabaseStartup(source, { "-B": 750, "-spin": 2 }, { "-B": 1000 });
  validateDatabaseStartupParameters(result);
  assert.deepEqual(result.parameters.map((item) => [item.name, item.displayValue, item.source]),
    [["-B", "1000", "queued"], ["-spin", "2", "scenario"]]);
  assert.deepEqual(result.parameters[0].overrides, ["scenario", "startup_file"]);
  assert.equal(result.startupFile.status, "present");
});

test("absent file keeps explicit scenario default, and no database default is invented", () => {
  const result = resolveDatabaseStartup({ ...source, startupFile: { status: "absent" }, entries: [] },
    { "-B": 750 }, {});
  assert.deepEqual(result.parameters.map((item) => item.source), ["scenario"]);
});

test("conflicting duplicate queued assignment is rejected", () => {
  assert.throws(() => resolveDatabaseStartup(source, {}, { "-B": 1000 }, { "-B": 900 }),
    /database_parameter_invalid:-B/);
});

test("a file-only run can be queued with no matrix dimensions", () => {
  const cells = expandMatrix({ runName: "file-only", scenario: { id: "scenario", version: "1.0.0" },
    dimensions: [], repetitions: 1, inputs: {} } as any, []);
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0].values, {});
  assert.deepEqual(cells[0].effectiveConfiguration, {});
  const startup = resolveDatabaseStartup(source, cells[0].effectiveConfiguration, cells[0].values);
  assert.equal(startup.parameters[0].displayValue, "500");
  assert.equal(startup.parameters[0].source, "startup_file");
});

test("database options cover core and conditional broker settings without client or platform factors", () => {
  const options = databaseParameterOptions({ version: "12.2", features: [] });
  assert.equal(options.contractVersion, "database-parameter-options.v1");
  assert.equal(options.parameters.find((item) => item.name === "-B")?.available, true);
  assert.equal(options.parameters.find((item) => item.name === "-aibufs")?.reason, "after_imaging_required");
  assert.equal(options.parameters.some((item) => ["-s", "database.cpuLimit", "pas.maxThreads"].includes(item.name)), false);
  assert.throws(() => validateScheduledDatabaseParameter("-s", 2, options), /database_parameter_not_allowed/);
  assert.throws(() => validateScheduledDatabaseParameter("-aibufs", 10, options), /after_imaging_required/);
  assert.throws(() => validateScheduledDatabaseParameter("-B", 1.5, options), /database_parameter_invalid/);
});

test("selected broker values are rendered without dropping flags", () => {
  const plan = parameterPlan({ "-B": 4096, "-directio": true, "-spin": 3000 });
  assert.deepEqual(plan.databaseStartupArgs, ["-B", "4096", "-directio", "-spin", "3000"]);
  assert.throws(() => parameterPlan({ "-s": 2 }), /database_parameter_not_allowed/);
});

test("bulk verification and scheduling reject a scenario that widens broker bounds", () => {
  const definition = {
    id: "buffer_pool",
    canonicalName: "-B",
    type: "integer" as const,
    minimum: 100,
    maximum: 1000,
    description: "Primary buffer pool size.",
    source: "scenario",
    matrixAllowed: true,
    secret: false as const,
    definitionVersion: "1"
  };
  assert.doesNotThrow(() => validateScenarioDatabaseParameterDefinitions([definition], { version: "12.8.11" }));
  assert.throws(() => validateScenarioDatabaseParameterDefinitions([{ ...definition, minimum: 0 }],
    { version: "12.8.11" }), /database_parameter_definition_widened:-B/);
  assert.throws(() => validateScenarioDatabaseParameterDefinitions([{ ...definition, defaultValue: 2000 }],
    { version: "12.8.11" }), /parameter_above_maximum:-B/);
});
