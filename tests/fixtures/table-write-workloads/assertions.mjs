/* Assertions over native record evidence, not acknowledgements or JS mock writes. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
export const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export function assertSnapshot(snapshot, table, { known = true } = {}) {
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.table, table.name);
  assert.equal(snapshot.count, snapshot.rows.length);
  for (const row of snapshot.rows) {
    assert.ok(row.$rowid);
    assert.deepEqual(
      Object.keys(row)
        .filter((k) => k !== "$rowid")
        .sort(),
      table.fields.map((f) => f.name).sort()
    );
    for (const field of table.fields) {
      if (!field.lob && known)
        assert.notEqual(row[field.name], null, table.name + "." + field.name);
      if (field.lob && row[field.name] !== null) {
        assert.ok(Number.isInteger(row[field.name].bytes) && row[field.name].bytes >= 0);
        assert.match(row[field.name].sha256, /^[a-f0-9]{64}$/i);
      }
    }
  }
  for (const index of table.indexes.filter((i) => i.unique)) {
    const tuples = snapshot.rows.map((r) =>
      JSON.stringify(
        index.components.map((c) => {
          const value = r[c.field ?? c.name];
          return typeof value === "string" ? value.toLowerCase() : value;
        })
      )
    );
    assert.equal(new Set(tuples).size, tuples.length, table.name + "." + index.name);
  }
}
export function assertRelationships(snapshots, inventory) {
  for (const table of inventory.tables)
    for (const field of table.fields.filter((f) => f.relationship)) {
      const rel = field.relationship;
      const parent = snapshots[rel.parentTable];
      assert.ok(parent, rel.parentTable);
      const values = new Set(parent.rows.map((r) => r[rel.parentField]));
      for (const row of snapshots[table.name].rows) {
        const value = row[field.name];
        assert.ok(
          (rel.optional && value === rel.absentValue) || values.has(value),
          table.name + "." + field.name + ":" + value
        );
      }
    }
  for (const [table, direction] of [
    ["CreditTransaction", "C"],
    ["DebitTransaction", "D"]
  ]) {
    const types = new Map(
      snapshots.TransactionType.rows.map((row) => [row.TransactionTypeId, row.Direction])
    );
    for (const row of snapshots[table].rows)
      assert.equal(types.get(row.TransactionTypeId), direction, table + ":type direction");
  }
}
export function assertTargetOnly(before, after, target) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const table of Object.keys(before))
    if (table !== target)
      assert.deepEqual(after[table], before[table], "nontarget changed:" + table);
}
export function assertPreserved(
  before,
  after,
  table,
  { selectedIds = [], fields = [], lobs = [] } = {}
) {
  assert.equal(after.rows.length, before.rows.length);
  const selected = new Set(selectedIds.map(String));
  const assigned = new Set([...fields, ...lobs].map((f) => f.toLowerCase()));
  const original = new Map(before.rows.map((r) => [String(r[table.primaryField]), r]));
  for (const row of after.rows) {
    const prior = original.get(String(row[table.primaryField]));
    assert.ok(prior, "identity replaced");
    assert.equal(row.$rowid, prior.$rowid);
    for (const field of table.fields)
      if (!selected.has(String(row[table.primaryField])) || !assigned.has(field.name.toLowerCase()))
        assert.deepEqual(row[field.name], prior[field.name], "unselected changed:" + field.name);
  }
}
export function readWitness(contents) {
  return contents.trim()
    ? contents
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const [table, id, kind, field, ...extra] = line.split(",");
          assert.ok(table && id && kind && field && !extra.length, "invalid witness");
          assert.ok(["ordinary", "lob", "selected"].includes(kind));
          return { table, id, kind, field };
        })
    : [];
}
export function assertAssignments(witness, table, ids, ordinary, lobs) {
  const expected = ids.flatMap((id) => [
    ...ordinary.map((field) => ({ table: table.name, id: String(id), kind: "ordinary", field })),
    ...lobs.map((field) => ({ table: table.name, id: String(id), kind: "lob", field }))
  ]);
  const key = (row) => [row.table, row.id, row.kind, row.field.toLowerCase()].join(",");
  assert.deepEqual(witness.map(key).sort(), expected.map(key).sort());
}
export function assertNoop(before, after, witness = []) {
  assert.deepEqual(after, before);
  assert.deepEqual(witness, []);
}
