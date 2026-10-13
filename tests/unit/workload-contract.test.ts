import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  checkContractAgainstSeed,
  validateWorkloadContract
} from "../../packages/contracts/src/workload-contract";

const contract = JSON.parse(
  fs.readFileSync("openedge/workloads/Workloads/ParkBench/bank_mix.contract.json", "utf8")
);

describe("workload-contract.v1", () => {
  it("accepts the ParkBench bank mix contract at its procedure path", () => {
    const parsed = validateWorkloadContract(contract, "Workloads/ParkBench/bank_mix.p");
    assert.equal(parsed.databaseName, "parkbench");
    assert.equal(parsed.readiness.mode, "validate");
    assert.throws(
      () => validateWorkloadContract(contract, "Workloads/Other/x.p"),
      /procedure_path/
    );
  });

  it("enforces every contract rule", () => {
    const cases: Array<[(value: any) => void, RegExp]> = [
      [(value) => (value.contractVersion = "workload-contract.v0"), /contractVersion/],
      [(value) => (value.procedure = "../x.p"), /procedure/],
      [(value) => (value.databaseName = "Sports-DB"), /databaseName/],
      [
        (value) => (value.operations[0].tables = ["NotRequired"]),
        /operations\.tables_required:NotRequired/
      ],
      [(value) => (value.writes.tables = ["Account"]), /writes\.tables_operation:Account/],
      [(value) => (value.operations[0].bounds = { min: 2, max: 1 }), /bounds_order/],
      [(value) => (value.operations[0].bounds = { min: 0, max: 10001 }), /operations\.bounds/],
      [(value) => (value.readiness = { mode: "validate", readOnly: false }), /readiness\.readOnly/],
      [(value) => (value.readiness = { mode: "maybe" }), /readiness\.mode/]
    ];
    for (const [mutate, expected] of cases) {
      const candidate = structuredClone(contract);
      mutate(candidate);
      assert.throws(() => validateWorkloadContract(candidate), expected);
    }
  });

  it("checks the contract's database against the selected seed before provisioning", () => {
    const parsed = validateWorkloadContract(contract);
    checkContractAgainstSeed(parsed, { databaseName: "parkbench" });
    assert.throws(
      () => checkContractAgainstSeed(parsed, { databaseName: "other" }),
      /workload_database_mismatch/
    );
  });
});

describe("workload-contract.v1 tableScope", () => {
  const generic = {
    contractVersion: "workload-contract.v1",
    id: "generic-arbitrary-reads",
    version: 1,
    procedure: "Workloads/Generic/arbitrary_reads.p",
    databaseName: "*",
    tableScope: "any",
    requiredTables: [],
    operations: [
      { op: "arbitrary-read", tables: ["*"], access: "dynamic-query", bounds: { min: 0, max: 10000 } }
    ],
    readiness: { mode: "none" }
  };

  it("accepts a generic any-table contract", () => {
    const parsed = validateWorkloadContract(structuredClone(generic), "Workloads/Generic/arbitrary_reads.p");
    assert.equal(parsed.tableScope, "any");
    checkContractAgainstSeed(parsed, { databaseName: "parkbench" });
    checkContractAgainstSeed(parsed, { databaseName: "other" });
  });

  it("enforces the any-scope rules", () => {
    const cases: Array<[(value: any) => void, RegExp]> = [
      [(value) => (value.operations[0].tables = ["Customer"]), /operations\.tables_any/],
      [(value) => (value.operations[0].tables = ["*", "Customer"]), /operations\.tables_any/],
      [(value) => (value.writes = { tables: ["*"] }), /writes\.any_scope/],
      [(value) => (value.readiness = { mode: "validate", readOnly: true }), /readiness\.any_scope/],
      [(value) => (value.databaseName = "Not-Valid"), /databaseName/],
      [(value) => (value.tableScope = "some"), /tableScope/]
    ];
    for (const [mutate, expected] of cases) {
      const candidate = structuredClone(generic);
      mutate(candidate);
      assert.throws(() => validateWorkloadContract(candidate), expected);
    }
    const emptyWrites = structuredClone(generic) as any;
    emptyWrites.writes = { tables: [] };
    validateWorkloadContract(emptyWrites);
  });

  it("keeps declared-scope contracts unchanged and rejects wildcards there", () => {
    for (const scope of [undefined, "declared"]) {
      const candidate = structuredClone(contract);
      if (scope) candidate.tableScope = scope;
      validateWorkloadContract(candidate, "Workloads/ParkBench/bank_mix.p");
      const wildcardDb = structuredClone(candidate);
      wildcardDb.databaseName = "*";
      assert.throws(() => validateWorkloadContract(wildcardDb), /databaseName/);
      const wildcardTable = structuredClone(candidate);
      wildcardTable.operations[0].tables = ["*"];
      assert.throws(() => validateWorkloadContract(wildcardTable), /operations\.tables_required:\*/);
      const emptyTables = structuredClone(candidate);
      emptyTables.requiredTables = [];
      assert.throws(() => validateWorkloadContract(emptyTables), /requiredTables/);
    }
  });
});
