import assert from "node:assert/strict";
import fs from "node:fs";
import { readDomains } from "../../../scripts/openedge/generate-write-workloads.mjs";
import {
  assertSnapshot,
  assertRelationships,
  assertTargetOnly,
  assertAssignments,
  readWitness,
  assertNoop,
  digest
} from "./assertions.mjs";
function capacity(table, snapshots) {
  const domains = readDomains().tables;
  const rows = snapshots[table.name].rows;
  if (table.name === "MerchantCategory")
    return (
      domains.MerchantCategory.reduce((n, r) => n + r.maximumCode - r.minimumCode + 1, 0) -
      rows.length
    );
  if (domains[table.name]) {
    const key = table.indexes.find((i) => i.unique && !i.primary).components[0].field;
    const used = new Set(rows.map((r) => r[key]));
    const currencies = new Set(snapshots.Currency.rows.map((r) => r.CurrencyCode));
    return domains[table.name].filter(
      (r) =>
        !used.has(r[key]) && (table.name !== "Country" || currencies.has(r.DefaultCurrencyCode))
    ).length;
  }
  if (table.name === "StatementDocument")
    return snapshots.AccountStatement.count - new Set(rows.map((r) => r.AccountStatementId)).size;
  if (table.name === "Transfer")
    return snapshots.DebitTransaction.count - new Set(rows.map((r) => r.DebitTransactionId)).size;
  return Infinity;
}
function assertOrdinary(rows, table) {
  for (const row of rows)
    for (const field of table.fields.filter((f) => !f.lob)) {
      const value = row[field.name];
      assert.notEqual(value, null, table.name + "." + field.name);
      if (field.type === "character")
        assert.ok(
          Buffer.byteLength(value) <= field.documentedCharacterWidth,
          table.name + "." + field.name
        );
      if (/^RandomInt(10|100|1000)$/.test(field.name))
        assert.ok(Number.isInteger(value) && value >= 1 && value <= Number(field.name.slice(9)));
      if (field.type === "decimal") assert.equal(Number(value.toFixed(field.decimals)), value);
      if (field.name === "TermsText") assert.ok(value.length >= 900);
      if (table.name === "Customer" && field.name === "Preferences") assert.ok(value.length >= 150);
    }
}
export async function run({ fixture, options, inventory, report }) {
  const names =
    options.tables && options.tables !== "all"
      ? options.tables.split(",")
      : inventory.tables.map((t) => t.name);
  fixture.compileDrivers(["prepare", "verify", "verify-create"]);
  fixture.prepareEmpty({ count: 400 });
  fixture.enableWitness(names);
  const cases = report.cases;
  for (const table of inventory.tables.filter((t) => names.includes(t.name))) {
    console.log("write_create_table:" + table.name);
    const lobNames = table.fields.filter((f) => f.lob).map((f) => f.name);
    const specifications = [
      ...[0, 1, 10, 100].map((limit) => ({ id: "limit-" + limit, limit, lobs: lobNames })),
      ...(lobNames.length
        ? [
            { id: "omitted-lobs", limit: 1, lobs: [] },
            ...lobNames.map((name) => ({ id: "only-" + name, limit: 1, lobs: [name] }))
          ]
        : []),
      {
        id: "ignored-create-only-extras",
        limit: 1,
        lobs: lobNames,
        extra: { FieldsList: { invalid: true }, WhereClause: 55 }
      }
    ];
    for (const spec of specifications) {
      const id = table.name + ":" + spec.id;
      if (options.case && options.case !== id) continue;
      const before = fixture.snapshotAll();
      fixture.resetWitness();
      const omittedMandatory = table.fields.some(
        (f) => f.lob && f.mandatory && !spec.lobs.includes(f.name)
      );
      const exhausted = spec.limit > capacity(table, before);
      const result = fixture.invokeCreate(table.name, {
        Operation: "create",
        Limit: spec.limit,
        LobFields: spec.lobs,
        ...spec.extra
      });
      const after = fixture.snapshotAll();
      const witness = readWitness(fs.readFileSync(fixture.witnessPath, "utf8"));
      assertTargetOnly(before, after, table.name);
      if (exhausted || omittedMandatory) {
        assert.equal(result.ok, false, id + ": required atomic failure");
        assert.deepEqual(after[table.name].rows, before[table.name].rows);
        assert.match(result.error, /exhaust|mandatory|constraint|assign|validat/i, id);
        cases.push({
          id,
          ok: true,
          outcome: "expected-atomic-failure",
          reason: exhausted ? "finite-capacity" : "mandatory-lob-omission",
          limit: spec.limit
        });
        continue;
      }
      assert.equal(result.ok, true, id + ":" + result.error);
      if (spec.limit === 0) assertNoop(before, after, witness);
      const original = new Set(before[table.name].rows.map((r) => r[table.primaryField]));
      const added = after[table.name].rows.filter((r) => !original.has(r[table.primaryField]));
      assert.equal(added.length, spec.limit, id);
      assertSnapshot(after[table.name], table);
      assertOrdinary(added, table);
      assertRelationships(after, inventory);
      assert.deepEqual(
        after[table.name].rows.filter((r) => original.has(r[table.primaryField])),
        before[table.name].rows
      );
      assertAssignments(
        witness,
        table,
        added.map((r) => r[table.primaryField]),
        table.fields.filter((f) => !f.lob).map((f) => f.name),
        spec.lobs
      );
      for (const row of added)
        for (const field of table.fields.filter((f) => f.lob)) {
          if (spec.lobs.includes(field.name)) {
            assert.equal(row[field.name].bytes, field.lob.defaultBytes);
            assert.ok(row[field.name].bytes > 0);
          } else assert.equal(row[field.name], null, id + ":omitted payload");
        }
      for (const row of added) {
        if (Object.hasOwn(row, "FileSizeBytes"))
          assert.equal(row.FileSizeBytes, row.Content?.bytes ?? 0);
        if (Object.hasOwn(row, "Checksum"))
          assert.equal(
            row.Checksum.toLowerCase(),
            row.PdfContent?.sha256.toLowerCase() ?? digest(Buffer.alloc(0))
          );
      }
      cases.push({
        id,
        ok: true,
        outcome: "created",
        limit: spec.limit,
        added: added.length,
        selectedLobs: spec.lobs
      });
    }
  }
  if (!options.case && names.includes("Account")) {
    report.pas = await fixture.startPas();
    const readinessBefore = fixture.snapshotAll();
    for (const table of inventory.tables) {
      const response = await fixture.request(table.name, { mode: "validate" });
      assert.equal(response.status, 200, table.name + ":schema readiness");
      cases.push({ id: table.name + ":read-only-readiness", ok: true, status: 200 });
    }
    assert.deepEqual(fixture.snapshotAll(), readinessBefore);
    // Real concurrent requests use the production HTTP handler and independently
    // inspect records/keys afterwards. Acknowledgements alone are insufficient.
    const before = fixture.snapshotAll();
    fixture.resetWitness();
    const responses = await Promise.all([
      fixture.request("Account", { Operation: "create", Limit: 1 }),
      fixture.request("Account", { Operation: "create", Limit: 1 })
    ]);
    assert.ok(
      responses.every((r) => r.status === 200),
      JSON.stringify(responses)
    );
    const after = fixture.snapshotAll();
    assertTargetOnly(before, after, "Account");
    assert.equal(after.Account.count - before.Account.count, 2);
    assertSnapshot(
      after.Account,
      inventory.tables.find((t) => t.name === "Account")
    );
    cases.push({
      id: "Account:concurrent-primary-business-keys",
      ok: true,
      statuses: responses.map((r) => r.status)
    });
  }
  if (!cases.length) throw new Error("write_native_no_cases_selected");
  return cases;
}
