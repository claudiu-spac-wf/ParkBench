import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import scenario from "../../examples/scenarios/parkbench-bank-mix.json";
import { validateScenario } from "../../packages/contracts/src/validator";
import { validateWorkloadContract } from "../../packages/contracts/src/workload-contract";

const procedure = fs.readFileSync("openedge/workloads/Workloads/ParkBench/bank_mix.p", "utf8");
const contract = validateWorkloadContract(
  JSON.parse(
    fs.readFileSync("openedge/workloads/Workloads/ParkBench/bank_mix.contract.json", "utf8")
  ),
  "Workloads/ParkBench/bank_mix.p"
);

describe("ParkBench bank mix workload and scenario", () => {
  it("keeps the packaging rule and handles every declared mode and operation", () => {
    assert.equal((procedure.match(/DEFINE\s+INPUT\s+PARAMETER\b/gi) ?? []).length, 1);
    assert.match(procedure, /DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO\./);
    assert.match(procedure, /workMode = "validate"/);
    for (const operation of contract.operations)
      assert.ok(procedure.includes(`WHEN "${operation.op}"`), operation.op);
    for (const prefix of [
      "database_schema_invalid:",
      "workload_bounds_violated:",
      "invalid_work_mode",
      "invalid_work_input"
    ])
      assert.ok(procedure.includes(prefix), prefix);
    // The load generator replaces "generated" in request bodies; the procedure must not emit it.
    assert.doesNotMatch(procedure, /"generated"/);
    for (const name of [
      ...(contract.requiredFields ?? []).map((field) => field.split(":")[0]),
      ...(contract.requiredIndexes ?? [])
    ])
      assert.ok(procedure.includes(name), name);
  });

  it("ships the configured smoke scenario from the contract", () => {
    const parsed = validateScenario(scenario);
    assert.equal(parsed.id, "parkbench-bank-mix");
    assert.equal(parsed.version, "1.0.0");
    assert.deepEqual(
      parsed.workload.operations.map((operation) => [operation.id, operation.weight]),
      [
        ["reference-point", 4],
        ["selective", 3],
        ["range", 2],
        ["audit-write-cycle", 1]
      ]
    );
    for (const operation of parsed.workload.operations)
      assert.deepEqual(operation.bodyTemplate, {
        procName: "Workloads/ParkBench/bank_mix.p",
        input: { mode: "run", op: operation.id, key: "generated" }
      });
    assert.deepEqual(parsed.workload.load, {
      mode: "constant-concurrency",
      concurrency: 2,
      maxInFlightPerWorker: 1,
      seed: 2026
    });
    assert.deepEqual(parsed.phases, {
      warmupSeconds: 60,
      measurementSeconds: 300,
      cooldownSeconds: 30
    });
    assert.deepEqual(
      parsed.observers.map((observer) => [observer.kind, observer.required]),
      [
        ["core", true],
        ["openedge_db_v1", true],
        ["openedge_pas_v1", true],
        ["file_sampler_v1", true]
      ]
    );
    assert.equal(parsed.observers[3].configuration?.path, "/psc/wrk/parkbench");
  });
});
