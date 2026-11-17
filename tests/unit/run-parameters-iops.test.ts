import test from "node:test";
import assert from "node:assert/strict";
import { expandMatrix } from "../../packages/contracts/src/matrix-expansion";
import { PLATFORM_RUN_PARAMETER_DEFINITIONS } from "../../packages/contracts/src/run-parameters";
import { parameterPlan, readParameterPlan } from "../../packages/compose-runner/src/parameters";
import { validateVariant } from "../../packages/contracts/src/variant";
const name = "storage.databaseIopsPreset";
const request: any = {
  runName: "iops-matrix",
  scenario: { id: "fixture", version: "1" },
  dimensions: [
    { name, values: ["hdd-t1", "unlimited"] },
    { name: "network.databaseLatencyMs", values: [0, 5] }
  ],
  repetitions: 2
};
test("IOPS is a real enum matrix dimension with one frozen condition per repetition", () => {
  const cells = expandMatrix(request, PLATFORM_RUN_PARAMETER_DEFINITIONS);
  assert.equal(cells.length, 8);
  assert.equal(new Set(cells.map((c) => c.ordinal)).size, 4);
  assert.deepEqual(
    cells.map((c) => c.databaseIops.presetId),
    ["hdd-t1", "hdd-t1", "hdd-t1", "hdd-t1", "unlimited", "unlimited", "unlimited", "unlimited"]
  );
  const omitted = expandMatrix(
    { ...request, dimensions: [], repetitions: 1 },
    PLATFORM_RUN_PARAMETER_DEFINITIONS
  );
  assert.equal(omitted[0].databaseIops.presetId, "unlimited");
  for (const values of [[], ["bad"], [150], ["hdd-t1", "hdd-t1"]])
    assert.throws(() =>
      expandMatrix(
        { ...request, dimensions: [{ name, values }] },
        PLATFORM_RUN_PARAMETER_DEFINITIONS
      )
    );
  assert.throws(() =>
    expandMatrix(
      { ...request, fixedOverrides: { [name]: "hdd-t1" } },
      PLATFORM_RUN_PARAMETER_DEFINITIONS
    )
  );
});
test("platform enum round trips without becoming a broker argument", () => {
  const p = parameterPlan({ [name]: "hdd-t1" });
  assert.equal(p.databaseIops?.presetId, "hdd-t1");
  assert.equal(readParameterPlan(p).databaseIops?.readIopsPerDevice, 1000);
  assert.deepEqual(p.databaseStartupArgs, []);
  assert.throws(() => validateVariant({ id: "x", name: "x", parameters: { [name]: "bogus" } }));
});
