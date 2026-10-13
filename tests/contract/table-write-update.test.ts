import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Ajv from "ajv/dist/2020";
import { inventory, contractFor, writeModule } from "../helpers/table-write";
const validate = new Ajv({ strict: false }).compile(
  JSON.parse(
    fs.readFileSync("packages/contracts/src/schemas/table-write-input-v1.schema.json", "utf8")
  )
);
describe("selective table-write update contract", () => {
  it("rejects primary identifiers, foreign names and wrong categories through inventory validation", async () => {
    const { validateWriteScenario } = await writeModule("validate-write-workloads");
    const example = JSON.parse(
      fs.readFileSync("tests/fixtures/table-write-workloads/scenario.example.json", "utf8")
    );
    const operation = example.workload.operations.find(
      (o: any) => o.bodyTemplate.input.Operation === "update"
    );
    const table = inventory.tables.find(
      (t: any) => t.procedure === operation.bodyTemplate.procName
    );
    for (const fields of [[table.primaryField], ["NoSuchField"]]) {
      const candidate = structuredClone(example);
      candidate.workload.operations.find(
        (o: any) => o.id === operation.id
      ).bodyTemplate.input.FieldsList = fields;
      assert.throws(() => validateWriteScenario(candidate), /write_scenario_field_invalid/);
    }
    const candidate = structuredClone(example);
    candidate.workload.operations.find(
      (o: any) => o.id === operation.id
    ).bodyTemplate.input.LobFields = [table.primaryField];
    assert.throws(() => validateWriteScenario(candidate), /write_scenario_field_invalid/);
    assert.doesNotThrow(() => validateWriteScenario(example));
  });
  it("requires explicit condition and selections for positive limits", () => {
    const valid = {
      Operation: "update",
      Limit: 1,
      WhereClause: "Account.RandomInt100 = 1 AND LENGTH(Account.Nickname) >= 3",
      FieldsList: ["Nickname"],
      LobFields: []
    };
    assert.equal(validate(valid), true);
    for (const clause of [undefined, null, "", " ", true, 55])
      assert.equal(validate({ ...valid, WhereClause: clause }), false);
    for (const fields of [null, 5, [null], [5], [""]])
      assert.equal(validate({ ...valid, FieldsList: fields }), false);
    assert.equal(validate({ ...valid, FieldsList: [], LobFields: [] }), false);
    assert.equal(validate({ ...valid, FieldsList: [], LobFields: ["NoticeText"] }), true); // semantic inventory/native checks reject wrong-table fields
    assert.equal(validate({ ...valid, Limit: 0, FieldsList: [], LobFields: [] }), true);
  });
  it("preserves per-table update bounds, target-only writes and acknowledgement contract", () => {
    for (const t of inventory.tables) {
      const c = contractFor(t.name);
      assert.deepEqual(c.operations.find((o: any) => o.op === "update").bounds, {
        min: 0,
        max: 10000
      });
      assert.deepEqual(c.writes.tables, [t.name]);
    }
  });
  it("accepts case variants and duplicates for native canonicalization without an all-fields default", () => {
    assert.equal(
      validate({
        Operation: "update",
        Limit: 10,
        WhereClause: "TRUE",
        FieldsList: ["nickname", "NICKNAME"],
        LobFields: []
      }),
      true
    );
    assert.equal(validate({ Operation: "update", Limit: 1, WhereClause: "TRUE" }), false);
    assert.equal(validate({ Operation: "update", Limit: 0, WhereClause: "TRUE" }), true);
  });
});
