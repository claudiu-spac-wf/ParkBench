import { describe, it } from "node:test";
import assert from "node:assert";
import { CORE_METRICS, validateScenario } from "../../packages/contracts/src";
import scenario from "../../examples/scenarios/crud-rest.json";
import workScenario from "../../examples/scenarios/parkbench-bank-mix.json";
describe("versioned contracts", () => {
  it("validates both bundled examples as v2 without observer metric selectors", () => {
    for (const example of [scenario, workScenario]) {
      const parsed = validateScenario(example);
      assert.equal(parsed.schemaVersion, "scenario.v2");
      assert.ok(parsed.observers.every((observer) => !Object.hasOwn(observer, "metrics")));
    }
  });
  it("contains independent disk I/O metrics", () => {
    assert.ok(CORE_METRICS.includes("parkbench_container_disk_read_bytes_total"));
    assert.ok(CORE_METRICS.includes("parkbench_host_disk_read_bytes_total"));
  });
  it("rejects unknown fields and duplicate operation identifiers", () => {
    assert.throws(() => validateScenario({ ...scenario, unexpected: true } as any), /scenario/);
    assert.throws(
      () =>
        validateScenario({
          ...scenario,
          workload: {
            ...scenario.workload,
            operations: [scenario.workload.operations[0], scenario.workload.operations[0]]
          }
        } as any),
      /scenario/
    );
  });
});
