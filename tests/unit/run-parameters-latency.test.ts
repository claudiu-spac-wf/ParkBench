import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DATABASE_LATENCY_PARAMETER,
  PLATFORM_RUN_PARAMETER_DEFINITIONS,
  databaseLatencyOf
} from "../../packages/contracts/src/run-parameters";
import { ALLOWED_PARAMETERS } from "../../packages/contracts/src/allowed-parameters";
import { latencyTolerance } from "../../packages/contracts/src/database-latency";
import { parameterPlan } from "../../packages/compose-runner/src/parameters";

describe("network.databaseLatencyMs run parameter", () => {
  it("is defined as a matrix-capable integer from 0 to 1000 ms", () => {
    const definition = PLATFORM_RUN_PARAMETER_DEFINITIONS.find(
      (item) => item.canonicalName === DATABASE_LATENCY_PARAMETER
    );
    assert.deepEqual(
      {
        id: definition?.id,
        type: definition?.type,
        minimum: definition?.minimum,
        maximum: definition?.maximum,
        step: definition?.step,
        unit: definition?.unit,
        defaultValue: definition?.defaultValue,
        matrixAllowed: definition?.matrixAllowed,
        source: definition?.source
      },
      {
        id: "param_network_databaseLatencyMs",
        type: "integer",
        minimum: 0,
        maximum: 1000,
        step: 1,
        unit: "ms",
        defaultValue: 0,
        matrixAllowed: true,
        source: "platform-run-parameters.v1"
      }
    );
    assert.deepEqual(ALLOWED_PARAMETERS[DATABASE_LATENCY_PARAMETER], {
      type: "number",
      min: 0,
      max: 1000
    });
  });

  it("translates into the runtime parameter plan", () => {
    assert.equal(parameterPlan({ [DATABASE_LATENCY_PARAMETER]: 20 }).databaseLatencyMs, 20);
    assert.equal(parameterPlan({ [DATABASE_LATENCY_PARAMETER]: 0 }).databaseLatencyMs, 0);
    assert.equal(parameterPlan({}).databaseLatencyMs, 0);
    for (const value of [2.5, -1, 1001, "20"])
      assert.throws(
        () => parameterPlan({ [DATABASE_LATENCY_PARAMETER]: value }),
        /invalid_parameter:network\.databaseLatencyMs/
      );
  });

  it("reads absent latency as 0 and uses the SC-007 tolerance", () => {
    assert.equal(databaseLatencyOf(undefined), 0);
    assert.equal(databaseLatencyOf({}), 0);
    assert.equal(databaseLatencyOf({ [DATABASE_LATENCY_PARAMETER]: 5 }), 5);
    assert.deepEqual(latencyTolerance(1), { min: 1, max: 3 });
    assert.deepEqual(latencyTolerance(20), { min: 36, max: 44 });
    assert.deepEqual(latencyTolerance(100), { min: 180, max: 220 });
  });
});
