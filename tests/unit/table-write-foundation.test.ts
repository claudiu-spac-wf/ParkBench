import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inventory, writeModule } from "../helpers/table-write";
const fixtureModule = () => writeModule("../../tests/fixtures/table-write-workloads/fixture-data");
const assertionsModule = () => writeModule("../../tests/fixtures/table-write-workloads/assertions");
describe("write verification foundation", () => {
  it("preloads independent known records with valid complete tuples and spare unique parents", async () => {
    const { fixtureData } = await fixtureModule();
    const { assertRelationships } = await assertionsModule();
    const data = fixtureData();
    assert.equal(data.tables.length, 32);
    const snapshots = Object.fromEntries(data.tables.map((t: any) => [t.name, { rows: t.rows }]));
    assertRelationships(snapshots, inventory);
    for (const table of inventory.tables) {
      const rows = snapshots[table.name].rows;
      for (const row of rows)
        for (const field of table.fields) {
          assert.notEqual(row[field.name], undefined, table.name + "." + field.name);
          assert.notEqual(row[field.name], null);
          if (field.type === "character")
            assert.ok(Buffer.byteLength(row[field.name]) <= field.documentedCharacterWidth);
          if (field.lob) assert.equal(row[field.name].bytes, field.lob.defaultBytes);
        }
      for (const index of table.indexes.filter((i: any) => i.unique)) {
        const tuples = rows.map((row: any) =>
          JSON.stringify(index.components.map((c: any) => row[c.field]))
        );
        assert.equal(new Set(tuples).size, tuples.length, table.name + "." + index.name);
      }
      if (
        !["Currency", "Country", "AccountType", "TransactionType", "MerchantCategory"].includes(
          table.name
        )
      ) {
        assert.ok(rows.length >= 100);
        assert.ok(rows.some((r: any) => r.RandomInt100 === 1));
        assert.ok(rows.some((r: any) => r.RandomInt100 !== 1));
      }
    }
    assert.ok(snapshots.StatementDocument.rows.length < snapshots.AccountStatement.rows.length);
    assert.ok(snapshots.Transfer.rows.length < snapshots.DebitTransaction.rows.length);
    assert.deepEqual(fixtureData({ variant: "empty" }).tables, []);
    const exhausted = fixtureData({ variant: "exhaustion" });
    assert.equal(exhausted.tables.find((t: any) => t.name === "Currency").rows.length, 40);
    assert.equal(exhausted.tables.find((t: any) => t.name === "Country").rows.length, 250);
  });
  it("detects omitted-field changes, replacement identities, duplicate/missing assignments and nontarget changes", async () => {
    const { assertPreserved, assertAssignments, assertTargetOnly } = await assertionsModule();
    const table = inventory.tables.find((t: any) => t.name === "Currency");
    const before = {
      rows: [{ $rowid: "10", CurrencyId: 1, CurrencyName: "same", IsActive: true }]
    };
    const after = structuredClone(before);
    assertPreserved(
      before,
      after,
      {
        ...table,
        fields: table.fields.filter((f: any) =>
          ["CurrencyId", "CurrencyName", "IsActive"].includes(f.name)
        )
      },
      { selectedIds: [1], fields: ["CurrencyName"] }
    );
    assertAssignments(
      [{ table: "Currency", id: "1", kind: "ordinary", field: "CurrencyName" }],
      table,
      [1],
      ["CurrencyName"],
      []
    );
    assert.throws(() => assertAssignments([], table, [1], ["CurrencyName"], []));
    assert.throws(() =>
      assertAssignments(
        [{ table: "Currency", id: "1", kind: "ordinary", field: "IsActive" }],
        table,
        [1],
        ["CurrencyName"],
        []
      )
    );
    after.rows[0].IsActive = false;
    assert.throws(() =>
      assertPreserved(before, after, table, { selectedIds: [1], fields: ["CurrencyName"] })
    );
    assert.throws(() =>
      assertTargetOnly(
        { Currency: before, Country: before },
        { Currency: before, Country: after },
        "Currency"
      )
    );
  });
  it("rejects unrecognized policies, wrong types, excess widths and invalid absent relationships", async () => {
    const { validatePolicy } = await writeModule("generate-write-workloads");
    const table = inventory.tables.find((t: any) => t.name === "Customer");
    const email = structuredClone(table.fields.find((f: any) => f.name === "Email"));
    for (const policy of [
      { kind: "fallback" },
      { kind: "literal", value: null },
      { kind: "literal", value: "x".repeat(81) },
      { kind: "lob" }
    ])
      assert.throws(
        () => validatePolicy(table, { ...email, writePolicy: policy }),
        /write_policy_/
      );
    assert.doesNotThrow(() =>
      validatePolicy(table, {
        ...email,
        writePolicy: { kind: "literal", value: "known@example.test" }
      })
    );
    const parent = table.fields.find((f: any) => f.name === "HomeBranchId");
    assert.throws(
      () => validatePolicy(table, { ...parent, writePolicy: { kind: "absent-parent", value: 0 } }),
      /write_policy_absent_parent/
    );
  });
  it("uses the real scenario validator plus fixed canonical procedures and semantic field validation", async () => {
    const { validateWriteScenario } = await writeModule("validate-write-workloads");
    const value = JSON.parse(
      fs.readFileSync("tests/fixtures/table-write-workloads/scenario.example.json", "utf8")
    );
    assert.equal(validateWriteScenario(value).workload.operations.length, 17);
    const malformed = structuredClone(value);
    malformed.workload.operations[0].bodyTemplate.procName = "Foreign/Write/DebitTransaction.p";
    assert.throws(() => validateWriteScenario(malformed), /write_scenario_unknown_table/);
    const wrong = structuredClone(value);
    wrong.workload.operations[0].bodyTemplate.input.LobFields = ["RandomInt100"];
    assert.throws(() => validateWriteScenario(wrong), /write_scenario_field_invalid/);
  });
});
