import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inventory, writeModule, contractFor } from "../helpers/table-write";
import { validateWorkScenario } from "../../packages/contracts/src/openedge-validation";
import { syntheticImageManifest } from "../helpers/openedge";

describe("reviewed banking write scenario", () => {
  it("preserves all 17 reviewed operations, fields, indexed conditions and weights", async () => {
    const actual = JSON.parse(
      fs.readFileSync("examples/scenarios/parkbench-banking-writes.json", "utf8")
    );
    const reviewed = JSON.parse(
      fs.readFileSync("tests/fixtures/table-write-workloads/scenario.example.json", "utf8")
    );
    const { validateWriteScenario } = await writeModule("validate-write-workloads");
    assert.doesNotThrow(() => validateWriteScenario(actual));
    const manifest = syntheticImageManifest("final");
    manifest.workloads = [
      ...new Set<string>(actual.workload.operations.map((op: any) => op.bodyTemplate.procName))
    ].map((procName) => ({
      ...manifest.workloads[0],
      procName,
      contract: {
        ...manifest.workloads[0].contract!,
        path: procName.replace(/\.p$/, ".contract.json")
      }
    }));
    assert.doesNotThrow(() => validateWorkScenario(actual));
    assert.doesNotThrow(() => validateWorkScenario(actual, manifest));
    const invalid = structuredClone(actual);
    invalid.workload.operations[0].bodyTemplate.input.Operation = "delete";
    assert.throws(() => validateWorkScenario(invalid), /input_operation:post-debits/);
    assert.deepEqual(actual, { ...reviewed, phases: { warmupSeconds: 60, measurementSeconds: 300, cooldownSeconds: 30 }, workload: { ...reviewed.workload, load: { ...reviewed.workload.load, concurrency: 25 } } });
    const ops = actual.workload.operations;
    assert.equal(ops.length, 17);
    assert.equal(new Set(ops.map((o: any) => o.bodyTemplate.procName)).size, 15);
    assert.equal(
      ops.reduce((n: number, o: any) => n + o.weight, 0),
      100
    );
    for (const [kind, weight] of [
      ["create", 64],
      ["update", 36]
    ])
      assert.equal(
        ops
          .filter((o: any) => o.bodyTemplate.input.Operation === kind)
          .reduce((n: number, o: any) => n + o.weight, 0),
        weight
      );
    assert.equal(
      ops
        .filter((o: any) => o.bodyTemplate.input.LobFields.length)
        .reduce((n: number, o: any) => n + o.weight, 0),
      11
    );
    for (const op of ops) {
      const table = inventory.tables.find((t: any) => t.procedure === op.bodyTemplate.procName);
      const input = op.bodyTemplate.input;
      assert.deepEqual(Object.keys(input).sort(), [
        "FieldsList",
        "Limit",
        "LobFields",
        "Operation",
        "WhereClause"
      ]);
      assert.equal(input.Limit, table.name === "ExchangeRate" ? 5 : 1);
      assert.ok(op.weight > 0);
      assert.deepEqual(contractFor(table.name).writes.tables, [table.name]);
      if (input.Operation === "update")
        assert.equal(
          input.WhereClause,
          table.name +
            "." +
            (["Employee", "ExchangeRate"].includes(table.name) ? "RandomInt10" : "RandomInt100") +
            " = 1"
        );
      assert.equal(JSON.stringify(op).includes("{{band}}"), false);
    }
  });
  it("retains production phases, observers and editable serialized load defaults", () => {
    const actual = JSON.parse(
      fs.readFileSync("examples/scenarios/parkbench-banking-writes.json", "utf8")
    );
    assert.deepEqual(actual.phases, {
      warmupSeconds: 60,
      measurementSeconds: 300,
      cooldownSeconds: 30
    });
    assert.deepEqual(actual.workload.load, {
      mode: "constant-concurrency",
      concurrency: 25,
      maxInFlightPerWorker: 1,
      seed: 2026
    });
    assert.equal(actual.target.pasReplicas, 1);
    assert.equal(actual.target.timeoutMs, 60000);
    assert.deepEqual(
      actual.observers.map((o: any) => o.kind),
      ["core", "openedge_db_v1", "openedge_pas_v1", "file_sampler_v1"]
    );
    assert.ok(actual.observers.every((o: any) => o.required));
  });
});
