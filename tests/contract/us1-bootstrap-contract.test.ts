import { describe, it } from "node:test";
import assert from "node:assert";
import scenario from "../../examples/scenarios/crud-rest.json";
import { validateScenario } from "../../packages/contracts/src";
describe("bootstrap contract", () => {
  it("accepts a versioned OpenEdge topology", () => {
    const result = validateScenario(scenario);
    assert.equal(result.target.pasReplicas, 1);
  });
});
