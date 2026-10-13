import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inventory, domains, writeModule } from "../helpers/table-write";

describe("table-write generation policies", () => {
  it("covers all 479 fields and all unique/relationship dependencies", async () => {
    const module = await writeModule("generate-write-workloads");
    assert.equal(
      inventory.tables.reduce((n: number, t: any) => n + t.fields.length, 0),
      479
    );
    assert.equal(
      inventory.tables.reduce((n: number, t: any) => n + t.indexes.length, 0),
      198
    );
    assert.doesNotThrow(() => module.validateInventory(inventory));
    for (const table of inventory.tables) {
      for (const index of table.indexes.filter((i: any) => i.unique)) {
        for (const component of index.components) {
          const field = table.fields.find((f: any) => f.name === component.field);
          assert.ok(field?.writePolicy?.kind, `${table.name}.${index.name}.${component.field}`);
        }
      }
      for (const field of table.fields) {
        assert.ok(field.writePolicy?.kind, table.name + "." + field.name);
        assert.ok(
          !["unknown", "default", "fallback"].includes(field.writePolicy.kind),
          table.name + "." + field.name
        );
        if (field.relationship) {
          assert.ok(["parent", "parent-unique", "absent-parent"].includes(field.writePolicy.kind));
          if (field.writePolicy.kind === "absent-parent") {
            assert.equal(field.relationship.optional, true);
            assert.equal(field.writePolicy.value, field.relationship.absentValue);
          }
        }
        if (field.lob) {
          assert.equal(field.writePolicy.kind, "lob");
          assert.ok(
            field.lob.minimumBytes <= field.lob.defaultBytes &&
              field.lob.defaultBytes <= field.lob.maximumBytes
          );
        }
        if (field.writePolicy.kind === "literal" && field.type === "character") {
          const width = Number(/x\((\d+)\)/i.exec(field.format)?.[1]);
          assert.ok(
            Buffer.byteLength(field.writePolicy.value) <= width,
            table.name + "." + field.name
          );
        }
        if (!field.lob && field.writePolicy.kind === "literal") {
          assert.notEqual(field.writePolicy.value, null, table.name + "." + field.name);
          assert.notEqual(field.writePolicy.value, undefined, table.name + "." + field.name);
          assert.notEqual(field.writePolicy.value, "?", table.name + "." + field.name);
          if (field.type === "decimal") {
            const value = Number(field.writePolicy.value);
            assert.ok(Number.isFinite(value), table.name + "." + field.name);
            assert.equal(
              Number(value.toFixed(field.decimals)),
              value,
              table.name + "." + field.name
            );
          }
        }
      }
    }
  });
  it("keeps finite catalog values within declared widths and decimal scales", () => {
    for (const [tableName, rows] of Object.entries(domains.tables)) {
      const table = inventory.tables.find((t: any) => t.name === tableName);
      assert.ok(table, tableName);
      for (const row of rows as any[])
        for (const [fieldName, value] of Object.entries(row)) {
          // Merchant categories are bounded ranges, expanded by the native generator.
          if (["minimumCode", "maximumCode"].includes(fieldName)) continue;
          const field = table.fields.find((f: any) => f.name === fieldName);
          assert.ok(field, tableName + "." + fieldName);
          assert.notEqual(value, null, tableName + "." + fieldName);
          if (field.type === "character") {
            assert.equal(typeof value, "string");
            assert.ok(
              Buffer.byteLength(value as string) <= field.documentedCharacterWidth,
              tableName + "." + fieldName
            );
          }
          if (field.type === "decimal") {
            assert.ok(Number.isFinite(Number(value)));
            assert.equal(
              Number(Number(value).toFixed(field.decimals)),
              Number(value),
              tableName + "." + fieldName
            );
          }
        }
    }
  });
  it("owns finite reference catalogs with coherent country currency references", () => {
    const currencies = new Set(domains.tables.Currency.map((r: any) => r.CurrencyCode));
    assert.equal(currencies.size, 40);
    assert.equal(domains.tables.Country.length, 250);
    assert.equal(domains.tables.AccountType.length, 24);
    assert.equal(domains.tables.TransactionType.length, 60);
    assert.ok(domains.tables.Country.every((r: any) => currencies.has(r.DefaultCurrencyCode)));
    assert.equal(new Set(domains.tables.Country.map((r: any) => r.CountryCode)).size, 250);
    assert.ok(
      domains.tables.MerchantCategory.every(
        (r: any) => r.minimumCode >= 1000 && r.maximumCode <= 9999
      )
    );
  });
  it("allows only explicit scaffolding before policies and preserves handwritten includes", async () => {
    const module = await writeModule("generate-write-workloads");
    const missing = structuredClone(inventory);
    delete missing.tables[0].fields[0].writePolicy;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-write-generator-"));
    try {
      fs.writeFileSync(path.join(root, "write-common.i"), "handwritten sentinel\n");
      module.generate({ scaffold: true, inventory: missing, domains, outputRoot: root });
      assert.equal(
        fs.readFileSync(path.join(root, "write-common.i"), "utf8"),
        "handwritten sentinel\n"
      );
      assert.ok(
        fs.readFileSync(path.join(root, "Currency.p"), "utf8").includes("PB-SCAFFOLD TRUE")
      );
      const before = fs.readFileSync(path.join(root, "Currency.p"), "utf8");
      assert.throws(
        () => module.generate({ inventory: missing, domains, outputRoot: root }),
        /write_policy_missing/
      );
      assert.throws(
        () => module.generate({ check: true, inventory: missing, domains, outputRoot: root }),
        /write_policy_missing/
      );
      assert.equal(fs.readFileSync(path.join(root, "Currency.p"), "utf8"), before);
      assert.throws(
        () =>
          module.generate({
            scaffold: true,
            check: true,
            inventory: missing,
            domains,
            outputRoot: root
          }),
        /write_scaffold_check_conflict/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
