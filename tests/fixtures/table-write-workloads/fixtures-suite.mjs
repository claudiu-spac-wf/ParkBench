import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixtureData } from "./fixture-data.mjs";
import { assertSnapshot, assertRelationships, digest } from "./assertions.mjs";
export async function run({ fixture, options, inventory, report }) {
  const cases = report.cases;
  const variants = options.case ? [options.case] : ["success", "empty", "exhaustion"];
  if (variants.some((v) => !["success", "empty", "exhaustion"].includes(v)))
    throw new Error("write_fixture_case_invalid");
  for (const variant of variants) {
    fixture.prepareEmpty({ variant });
    const expected = fixtureData({ variant });
    const snapshots = {};
    const allSnapshots = fixture.snapshotAll();
    for (const table of inventory.tables) {
      const snapshot = allSnapshots[table.name];
      assertSnapshot(snapshot, table);
      const rows = expected.tables.find((t) => t.name === table.name)?.rows ?? [];
      assert.equal(snapshot.rows.length, rows.length);
      for (const actual of snapshot.rows) {
        const original = rows.find((r) => r[table.primaryField] === actual[table.primaryField]);
        assert.ok(original);
        for (const field of table.fields) {
          if (field.lob) {
            const { bytes, pattern } = original[field.name];
            const content = Buffer.from(
              pattern.repeat(Math.ceil(bytes / pattern.length)).slice(0, bytes)
            );
            assert.equal(actual[field.name].bytes, bytes);
            assert.equal(actual[field.name].sha256.toLowerCase(), digest(content));
          } else if (["datetime", "datetime-tz"].includes(field.type)) {
            const normalized = actual[field.name].replace(
              /^(\d{2})\/(\d{2})\/(\d{4}) /,
              "$3-$1-$2T"
            );
            assert.equal(normalized, original[field.name]);
          } else
            assert.deepEqual(
              actual[field.name],
              original[field.name],
              table.name + "." + field.name
            );
        }
      }
      snapshots[table.name] = snapshot;
      cases.push({ id: variant + ":" + table.name, ok: true, rows: snapshot.count });
    }
    assertRelationships(snapshots, inventory);
    fs.writeFileSync(
      path.join(fixture.root, variant + "-snapshots.json"),
      JSON.stringify(snapshots, null, 2)
    );
  }
  return cases;
}
