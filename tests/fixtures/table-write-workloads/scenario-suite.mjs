import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { repositoryRoot } from "../../../scripts/openedge/generate-write-workloads.mjs";
import { validateWriteScenario } from "../../../scripts/openedge/validate-write-workloads.mjs";
import * as assertions from "./assertions.mjs";
const require = createRequire(import.meta.url);
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export async function run({ fixture, options, inventory, report }) {
  const filename = path.resolve(
    options.scenario ?? "examples/scenarios/parkbench-banking-writes.json"
  );
  const scenario = validateWriteScenario(JSON.parse(fs.readFileSync(filename, "utf8")), inventory);
  report.scenarioHash = hash(filename);
  fixture.compileDrivers(["prepare", "verify", "verify-create", "verify-update"]);
  fixture.prepareEmpty({ count: 400 });
  fixture.enableWitness(inventory.tables.map((t) => t.name));
  if (options.case !== "measured") {
    const operationCases = [];
    for (const operation of scenario.workload.operations) {
      console.log("banking_write_operation:" + operation.id);
      const table = inventory.tables.find((t) => t.procedure === operation.bodyTemplate.procName);
      const input = operation.bodyTemplate.input;
      const before = fixture.snapshotAll();
      fixture.resetWitness();
      const result =
        input.Operation === "create"
          ? fixture.invokeCreate(table.name, input)
          : fixture.invokeUpdate(table.name, input);
      assert.equal(result.ok, true, operation.id + ":" + result.error);
      const after = fixture.snapshotAll();
      const trace = assertions.readWitness(fs.readFileSync(fixture.witnessPath, "utf8"));
      assertions.assertTargetOnly(before, after, table.name);
      assertions.assertSnapshot(after[table.name], table);
      assertions.assertRelationships(after, inventory);
      let ids;
      let fields;
      if (input.Operation === "create") {
        const existing = new Set(before[table.name].rows.map((r) => r[table.primaryField]));
        ids = after[table.name].rows
          .filter((r) => !existing.has(r[table.primaryField]))
          .map((r) => r[table.primaryField]);
        assert.equal(ids.length, input.Limit);
        fields = table.fields.filter((f) => !f.lob).map((f) => f.name);
        assert.deepEqual(
          after[table.name].rows.filter((r) => existing.has(r[table.primaryField])),
          before[table.name].rows
        );
      } else {
        const random = input.WhereClause.includes("RandomInt10 =") ? "RandomInt10" : "RandomInt100";
        ids = before[table.name].rows
          .filter((r) => r[random] === 1)
          .slice(0, input.Limit)
          .map((r) => r[table.primaryField]);
        assert.equal(ids.length, input.Limit, operation.id + ":prepared matching writes");
        assert.deepEqual(
          trace.filter((w) => w.kind === "selected").map((w) => Number(w.id)),
          ids
        );
        fields = input.FieldsList;
        assertions.assertPreserved(before[table.name], after[table.name], table, {
          selectedIds: ids,
          fields,
          lobs: input.LobFields
        });
      }
      assertions.assertAssignments(
        trace.filter((w) => w.kind !== "selected"),
        table,
        ids,
        fields,
        input.LobFields
      );
      for (const row of after[table.name].rows.filter((r) => ids.includes(r[table.primaryField]))) {
        for (const field of table.fields.filter((f) => f.lob)) {
          if (input.LobFields.includes(field.name))
            assert.equal(row[field.name].bytes, field.lob.defaultBytes);
          else if (input.Operation === "create") assert.equal(row[field.name], null);
        }
        if (fields.includes("FileSizeBytes"))
          assert.equal(row.FileSizeBytes, row.Content?.bytes ?? 0);
        if (fields.includes("Checksum"))
          assert.equal(row.Checksum.toLowerCase(), row.PdfContent.sha256.toLowerCase());
      }
      const entry = {
        id: operation.id,
        ok: true,
        table: table.name,
        operation: input.Operation,
        assignedIds: ids,
        fields,
        lobs: input.LobFields
      };
      operationCases.push(entry);
      report.cases.push(entry);
    }
    assert.equal(operationCases.length, 17);
    fs.writeFileSync(
      path.join(repositoryRoot, ".parkbench/validation/banking-write-operations.json"),
      JSON.stringify(
        {
          ...report,
          suite: "scenario-operations",
          ok: true,
          cases: operationCases,
          completedAt: new Date().toISOString()
        },
        null,
        2
      ) + "\n"
    );
  }
  if (options.case === "operations") return report.cases;
  // Reset independently loaded source data, export it offline, and let real
  // production orchestration make and clean two independent run-owned copies.
  fixture.prepareEmpty({ count: 400 });
  const expected = fixture.snapshotAll();
  const seedRoot = fixture.exportPreparedSeed();
  const helper = require("tsx/cjs/api").require(
    path.join(repositoryRoot, "tests/helpers/table-write-scenario.ts"),
    import.meta.url
  );
  report.measured = await helper.runMeasuredScenario({
    evidenceRoot: fixture.root,
    seedRoot,
    expected,
    inventory,
    assertions,
    scenario
  });
  report.cases.push({
    id: `production-${scenario.phases.measurementSeconds}-second-measurements-and-independent-copies`,
    ok: true,
    runs: report.measured.runs.length
  });
  return report.cases;
}
