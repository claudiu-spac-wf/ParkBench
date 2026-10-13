import assert from "node:assert/strict";
import fs from "node:fs";
import {
  assertSnapshot,
  assertPreserved,
  assertTargetOnly,
  assertAssignments,
  assertRelationships,
  assertNoop,
  readWitness
} from "./assertions.mjs";
const canonical = (values, table) => [
  ...new Set(
    values.map((v) => table.fields.find((f) => f.name.toLowerCase() === v.toLowerCase()).name)
  )
];
export async function run({ fixture, options, inventory, report }) {
  const names =
    options.tables && options.tables !== "all"
      ? options.tables.split(",")
      : inventory.tables.map((t) => t.name);
  fixture.compileDrivers(["prepare", "verify", "verify-update"]);
  fixture.prepareEmpty({ count: 400 }); // Independent preloading; never calls production creates.
  fixture.enableWitness(names);
  const cases = report.cases;
  for (const table of inventory.tables.filter((t) => names.includes(t.name))) {
    console.log("write_update_table:" + table.name);
    const ordinary = table.fields
      .filter((f) => !f.lob && f.name !== table.primaryField)
      .map((f) => f.name);
    const lobs = table.fields.filter((f) => f.lob).map((f) => f.name);
    const specs = [
      ...[0, 1, 10, 100].map((limit) => ({
        id: "limit-" + limit,
        limit,
        where: table.name + ".RandomInt100 = 1",
        fields: ["RandomInt100"],
        lobs: []
      })),
      ...[
        [1, 1],
        [10, 5],
        [10, 10],
        [10, 20],
        [100, 50],
        [100, 100],
        [100, 150]
      ].map(([limit, matches]) => ({
        id: "cardinality-" + limit + "-" + matches,
        limit,
        matches,
        where: table.name + "." + table.primaryField + " <= " + matches,
        fields: ["RandomInt10"],
        lobs: []
      })),
      { id: "no-match", limit: 10, where: "FALSE", fields: ["RandomInt10"], lobs: [] },
      {
        id: "function-compound",
        limit: 10,
        where:
          "LENGTH(STRING(" +
          table.name +
          "." +
          table.primaryField +
          ")) >= 1 AND " +
          table.name +
          ".RandomInt10 >= 1",
        fields: ["RandomInt1000"],
        lobs: []
      },
      {
        id: "volatile",
        limit: 100,
        where: "RANDOM(1, 2) = 1",
        fields: ["RandomInt100"],
        lobs: [],
        volatile: true
      },
      {
        id: "case-dedup",
        limit: 1,
        where: "TRUE",
        fields: ["randomint10", "RANDOMINT10"],
        lobs: []
      },
      { id: "all-ordinary", limit: 1, where: "TRUE", fields: ordinary, lobs: [] },
      ...(table.name === "Account"
        ? [
            {
              id: "quoted-boundary",
              limit: 1,
              where: "LENGTH(')') = 1 AND LENGTH(\"(\") = 1",
              fields: ["RandomInt10"],
              lobs: []
            },
            {
              id: "comment-boundary",
              limit: 1,
              where: "/* ) /* ( */ nested */ TRUE // ) ignored\n",
              fields: ["RandomInt10"],
              lobs: []
            },
            {
              id: "escaped-quote",
              limit: 1,
              where: "LENGTH('it~'s )') > 1",
              fields: ["RandomInt10"],
              lobs: []
            }
          ]
        : []),
      ...lobs.map((name) => ({
        id: "lob-only-" + name,
        limit: 1,
        where: "TRUE",
        fields: [],
        lobs: [name]
      })),
      ...(lobs.length
        ? [
            {
              id: "combined",
              limit: 1,
              where: "TRUE",
              fields: [
                "RandomInt10",
                ...["UpdatedAt", "FileSizeBytes", "Checksum"].filter((name) =>
                  ordinary.includes(name)
                )
              ],
              lobs
            }
          ]
        : []),
      ...["FileSizeBytes", "Checksum"]
        .filter((name) => ordinary.includes(name))
        .map((name) => ({
          id: "existing-companion-" + name,
          limit: 1,
          where: "TRUE",
          fields: [name],
          lobs: []
        }))
    ];
    for (const spec of specs) {
      const id = table.name + ":" + spec.id;
      if (options.case && id !== options.case) continue;
      const before = fixture.snapshotAll();
      const selected = spec.volatile
        ? null
        : before[table.name].rows
            .filter((row) => {
              if (spec.where === "FALSE") return false;
              if (spec.where.includes("RandomInt100 = 1")) return row.RandomInt100 === 1;
              if (spec.matches) return row[table.primaryField] <= spec.matches;
              return true;
            })
            .slice(0, spec.limit)
            .map((row) => row[table.primaryField]);
      fixture.resetWitness();
      const result = fixture.invokeUpdate(table.name, {
        Operation: "update",
        Limit: spec.limit,
        WhereClause: spec.where,
        FieldsList: spec.fields,
        LobFields: spec.lobs
      });
      assert.equal(result.ok, true, id + ":" + result.error);
      const after = fixture.snapshotAll();
      const trace = readWitness(fs.readFileSync(fixture.witnessPath, "utf8"));
      const frozen = trace.filter((w) => w.kind === "selected").map((w) => Number(w.id));
      if (spec.volatile) {
        assert.ok(frozen.length <= spec.limit);
        assert.equal(new Set(frozen).size, frozen.length);
        assert.deepEqual(
          frozen,
          [...frozen].sort((a, b) => a - b)
        );
      } else assert.deepEqual(frozen, selected, id + ":ascending frozen identities");
      const ids = selected ?? frozen;
      const fields = canonical(spec.fields, table);
      const payloads = canonical(spec.lobs, table);
      assertTargetOnly(before, after, table.name);
      assertPreserved(before[table.name], after[table.name], table, {
        selectedIds: ids,
        fields,
        lobs: payloads
      });
      assertAssignments(
        trace.filter((w) => w.kind !== "selected"),
        table,
        ids,
        fields,
        payloads
      );
      assertSnapshot(after[table.name], table);
      assertRelationships(after, inventory);
      if (!ids.length) assertNoop(before, after, trace);
      for (const row of after[table.name].rows.filter((row) =>
        ids.includes(row[table.primaryField])
      ))
        for (const name of payloads)
          assert.equal(row[name].bytes, table.fields.find((f) => f.name === name).lob.defaultBytes);
      for (const row of after[table.name].rows.filter((row) =>
        ids.includes(row[table.primaryField])
      )) {
        if (fields.includes("FileSizeBytes"))
          assert.equal(row.FileSizeBytes, row.Content?.bytes ?? 0);
        if (fields.includes("Checksum"))
          assert.equal(row.Checksum.toLowerCase(), row.PdfContent.sha256.toLowerCase());
      }
      cases.push({
        id,
        ok: true,
        limit: spec.limit,
        selected: ids.length,
        fields,
        lobs: payloads,
        ...(spec.matches && before[table.name].count < spec.matches
          ? { unavailableCardinality: spec.matches, actualAvailable: before[table.name].count }
          : {})
      });
    }
  }
  if (!cases.length) throw new Error("write_native_no_cases_selected");
  return cases;
}
