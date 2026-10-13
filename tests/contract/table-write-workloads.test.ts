import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020";
import { validateWorkloadContract } from "../../packages/contracts/src/workload-contract";
import { inventory, writeRoot, contractFor, writeModule } from "../helpers/table-write";

const schema = JSON.parse(
  fs.readFileSync("packages/contracts/src/schemas/table-write-input-v1.schema.json", "utf8")
);
const validateInput = new Ajv({ strict: false }).compile(schema);
describe("per-table write create contract", () => {
  it("has exactly 32 independently discoverable single-input procedures", async () => {
    const runner = await writeModule("package-runner");
    const entries = runner.discoverWorkloads(path.resolve("openedge/workloads/Workloads"), {
      compile: false
    });
    const writes = entries.filter((p: any) => p.procName.startsWith("Workloads/Write/"));
    assert.equal(writes.length, 32);
    assert.deepEqual(
      writes.map((p: any) => p.procName).sort(),
      inventory.tables.map((t: any) => t.procedure).sort()
    );
    for (const table of inventory.tables) {
      const source = fs.readFileSync(path.join(writeRoot, table.name + ".p"), "utf8");
      assert.equal((source.match(/DEFINE\s+INPUT\s+PARAMETER/g) ?? []).length, 1);
      assert.ok(source.includes("DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO."));
      assert.ok(source.includes("&SCOPED-DEFINE PB-TABLE " + table.name + "\n"));
    }
  });
  it("declares target-only writes and shape-only readiness for every table", () => {
    for (const table of inventory.tables) {
      const contract = validateWorkloadContract(contractFor(table.name), table.procedure);
      assert.deepEqual(contract.writes?.tables, [table.name]);
      assert.deepEqual(contract.requiredSequences, [table.sequence]);
      assert.ok(contract.requiredTables.every((t) => t.minimumRows === 0));
      assert.equal(contract.readiness.readOnly, true);
      assert.equal(contract.readiness.failurePrefix, "database_schema_invalid:");
      assert.deepEqual(
        contract.operations.map((o) => [o.op, o.bounds]),
        [
          ["create", { min: 0, max: 10000 }],
          ["update", { min: 0, max: 10000 }]
        ]
      );
    }
  });
  it("ignores invalid update-only values on creates and defaults selections to empty", () => {
    for (const ignored of [null, 5, false, {}, ["not-a-field"]]) {
      assert.equal(
        validateInput({ Operation: "create", Limit: 1, FieldsList: ignored, WhereClause: ignored }),
        true
      );
    }
    assert.equal(validateInput({ Operation: "create", Limit: 0 }), true);
    assert.equal(validateInput({ Operation: "create", Limit: 10000, LobFields: [] }), true);
    assert.equal(validateInput({ Operation: "create", Limit: 1, LobFields: null }), false);
  });
  it("keeps reserved readiness separate from operational inputs", () => {
    assert.equal(validateInput({ mode: "validate" }), false);
    for (const table of inventory.tables)
      assert.equal(contractFor(table.name).readiness.mode, "validate");
  });
  it("preserves the runner acknowledgement fields without record-count output", () => {
    const runner = fs.readFileSync("openedge/runner/ParkBenchWorkHandler.cls", "utf8");
    const acknowledgement = runner.slice(
      runner.indexOf("responseBody = NEW JsonObject()."),
      runner.indexOf("RETURN SendJson(responseBody, INTEGER(StatusCodeEnum:OK)).")
    );
    assert.deepEqual(
      Array.from(acknowledgement.matchAll(/responseBody:Add\("([^"]+)"/g), (m) => m[1]),
      ["ok", "procName", "elapsedMs", "requestId"]
    );
    // Native HTTP cases must verify these fields on the wire; source checks
    // establish the existing contract without claiming persisted row evidence.
  });
});
