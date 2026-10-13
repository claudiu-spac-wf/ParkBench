import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import readMix from "../../examples/scenarios/parkbench-read-mix.json";
import bankMix from "../../examples/scenarios/parkbench-bank-mix.json";
import { validateScenario } from "../../packages/contracts/src/validator";
import { validateWorkScenario } from "../../packages/contracts/src/openedge-validation";
import { syntheticImageManifest } from "../helpers/openedge";

const PROCEDURE = "Workloads/Generic/arbitrary_reads.p";
const TINY = new Set(["Currency", "TransactionType", "AccountType", "Country", "MerchantCategory"]);
const WIDE = new Set(["AccountType", "Customer", "Loan"]);
const VERY_LARGE = new Set(["DebitTransaction", "CardAuthorization", "AuditLog"]);
const NARROW_LARGE = new Set([
  "CardAuthorization",
  "AuditLog",
  "LoginEvent",
  "Transfer",
  "LoanPayment"
]);

const operations = readMix.workload.operations as any[];
const inputOf = (operation: any) => operation.bodyTemplate.input;

function manifestWithGeneric() {
  const manifest = syntheticImageManifest("final") as any;
  manifest.workloads.push({
    ...manifest.workloads[0],
    procName: PROCEDURE,
    contract: { path: "Workloads/Generic/arbitrary_reads.contract.json" }
  });
  return manifest;
}

describe("parkbench-read-mix scenario", () => {
  it("is a valid /work scenario that only calls the generic workload", () => {
    validateScenario(readMix);
    validateWorkScenario(readMix, manifestWithGeneric());
    assert.equal(readMix.id, "parkbench-read-mix");
    assert.equal(operations.length, 16);
    for (const operation of operations) {
      assert.equal(operation.bodyTemplate.procName, PROCEDURE, operation.id);
      assert.equal(inputOf(operation).mode, "run", operation.id);
      assert.deepEqual(operation.expectedStatus, [200], operation.id);
    }
  });

  it("covers every required table shape", () => {
    const tables = operations.map((operation) => inputOf(operation).TableName as string);
    for (const table of ["Currency", "TransactionType", "AccountType"])
      assert.ok(tables.includes(table), table);
    for (const table of ["AccountType", "Customer"]) assert.ok(tables.includes(table), table);
    assert.ok(
      tables.some((table) => NARROW_LARGE.has(table)),
      "narrow large table"
    );
    const projected = operations.filter(
      (operation) =>
        VERY_LARGE.has(inputOf(operation).TableName) &&
        Array.isArray(inputOf(operation).FieldsList) &&
        inputOf(operation).FieldsList.length >= 1 &&
        inputOf(operation).FieldsList.length <= 2
    );
    assert.ok(new Set(projected.map((operation) => inputOf(operation).TableName)).size >= 2);
    const debit = projected.find(
      (operation) => inputOf(operation).TableName === "DebitTransaction"
    );
    assert.deepEqual(inputOf(debit).FieldsList, ["AccountId", "Amount"]);
    const lobTables = new Set(
      operations
        .filter((operation) => (inputOf(operation).LobFields ?? []).length > 0)
        .map((operation) => inputOf(operation).TableName)
    );
    assert.ok(lobTables.size >= 4, `LOB tables: ${[...lobTables].join(",")}`);
    assert.ok(
      tables.some((table) => WIDE.has(table) && !TINY.has(table)),
      "wide non-tiny table"
    );
  });

  it("admits complete uniformly sampled buckets within the authored literal cutoff", () => {
    for (const operation of operations) {
      const input = inputOf(operation);
      assert.equal(
        input.WhereClause,
        "RandomInt100 <= 100 AND RandomInt100 = {{band}}",
        operation.id
      );
      assert.equal(input.Limit, 0, operation.id);
      assert.deepEqual(
        operation.templateValues.band,
        { kind: "uniformInt", min: 1, max: 75 },
        operation.id
      );
    }
  });

  it("weights cheap reads at least as high as LOB reads", () => {
    const tinyWeights = operations
      .filter((operation) => TINY.has(inputOf(operation).TableName))
      .map((operation) => operation.weight);
    const lobWeights = operations
      .filter((operation) => (inputOf(operation).LobFields ?? []).length > 0)
      .map((operation) => operation.weight);
    assert.ok(Math.min(...tinyWeights) >= Math.max(...lobWeights));
  });

  it("keeps the bank mix target and observers with the authored read schedule, a fixed load, and is bundled", () => {
    assert.deepEqual(readMix.target, bankMix.target);
    assert.deepEqual(readMix.workload.load, {
      mode: "constant-concurrency",
      concurrency: 35,
      maxInFlightPerWorker: 1,
      seed: 2026
    });
    assert.deepEqual(readMix.phases, {
      warmupSeconds: 60,
      measurementSeconds: 180,
      cooldownSeconds: 30
    });
    assert.deepEqual(readMix.observers, bankMix.observers);
    const contract = JSON.parse(
      fs.readFileSync("openedge/workloads/Workloads/Generic/arbitrary_reads.contract.json", "utf8")
    );
    assert.equal(contract.writes, undefined);
    assert.match(
      fs.readFileSync("apps/control-plane/src/scenarios/builtins.ts", "utf8"),
      /"parkbench-read-mix\.json"/
    );
  });
});
