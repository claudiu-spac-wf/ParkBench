import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateScenario } from "../../packages/contracts/src/validator";
import { validateWorkScenario } from "../../packages/contracts/src/openedge-validation";
import { validateWorkloadContract } from "../../packages/contracts/src/workload-contract";
import { ScenarioFileSource } from "../../apps/control-plane/src/catalog/scenario-source";
import { ScenarioCatalog } from "../../apps/control-plane/src/scenarios/catalog";
import { registerBundledScenarios } from "../../apps/control-plane/src/scenarios/builtins";
import { DataFactory } from "../../apps/loadgen/src/data-factory";
import { OperationSelector } from "../../apps/loadgen/src/operation-selector";
import { renderBody } from "../../apps/loadgen/src/runner";
import { syntheticImageManifest } from "../helpers/openedge";

const scenarioId = "parkbench-read-stable";
const scenarioPath = `examples/scenarios/${scenarioId}.json`;
const scenario = () => validateScenario(JSON.parse(fs.readFileSync(scenarioPath, "utf8")));

test("stable reads use one compatible bounded read path with no LOB columns", () => {
  const preset = scenario();
  validateWorkScenario(preset, syntheticImageManifest("final"));
  assert.equal(preset.version, "1.0.0");
  assert.equal(preset.workload.operations.length, 1);
  const operation = preset.workload.operations[0];
  assert.equal(operation.method, "POST");
  assert.equal(operation.path, "/work");
  assert.deepEqual(operation.expectedStatus, [200]);
  assert.deepEqual(operation.bodyTemplate, {
    procName: "Workloads/ParkBench/bank_mix.p",
    input: { mode: "run", op: "range", key: "generated" }
  });
  const contract = validateWorkloadContract(
    JSON.parse(
      fs.readFileSync("openedge/workloads/Workloads/ParkBench/bank_mix.contract.json", "utf8")
    )
  );
  const read = contract.operations.find((op) => op.op === "range")!;
  assert.deepEqual(read.tables, ["DebitTransaction"]);
  assert.deepEqual(read.bounds, { min: 1, max: 100 });
  assert.equal(read.width, 100);
  const inventory = JSON.parse(
    fs.readFileSync("scripts/openedge/table-write-inventory.json", "utf8")
  );
  const table = inventory.tables.find((table: any) => table.name === read.tables[0]);
  assert.ok(table);
  assert.ok(
    table.fields.every((field: any) => !["BLOB", "CLOB"].includes(field.type.toUpperCase()))
  );
  assert.ok(
    table.indexes.some((index: any) => index.name === "PkDebitTransaction" && index.primary)
  );
});

test("stable reads retain all observers and give cache warmup and measurement more time", () => {
  const preset = scenario();
  assert.deepEqual(preset.phases, {
    warmupSeconds: 120,
    measurementSeconds: 300,
    cooldownSeconds: 30
  });
  assert.deepEqual(preset.workload.load, {
    mode: "constant-concurrency",
    concurrency: 25,
    maxInFlightPerWorker: 1,
    seed: 2026
  });
  assert.equal(preset.target.pasReplicas, 1);
  assert.equal(preset.target.timeoutMs, 60000);
  assert.deepEqual(preset.observers.map((observer) => observer.kind).sort(), [
    "core",
    "file_sampler_v1",
    "openedge_db_v1",
    "openedge_pas_v1"
  ]);
  assert.ok(
    preset.observers.every(
      (observer) => observer.required && observer.samplingIntervalSeconds === 5
    )
  );
});

test("seeded stable requests replay per worker and sample across the table rather than one hot range", () => {
  const preset = scenario();
  const requests = (worker: number, seed = preset.workload.load.seed!) => {
    const factory = new DataFactory((seed + worker) >>> 0);
    const selector = new OperationSelector(preset.workload.operations, () => factory.next());
    return Array.from(
      { length: 1000 },
      () => renderBody(selector.next().bodyTemplate, factory) as any
    );
  };
  const first = requests(0);
  assert.deepEqual(first, requests(0));
  assert.notDeepEqual(first, requests(0, 2027));
  for (let worker = 1; worker < 25; worker++) assert.notDeepEqual(first, requests(worker));
  assert.ok(
    first.every(
      (request) => request.input.op === "range" && Number.isInteger(request.input.key.sequence)
    )
  );
  const report = JSON.parse(
    fs.readFileSync("examples/calibrations/parkbench-read-calibration.json", "utf8")
  );
  const table = report.tables.find((table: any) => table.name === "DebitTransaction");
  const denseSeedRows = table.buckets.reduce(
    (sum: number, bucket: any) => sum + bucket.rowCount,
    0
  );
  assert.ok(denseSeedRows >= 100);
  const starts = first.map(
    (request) => 1 + (request.input.key.sequence % Math.max(1, denseSeedRows - 100))
  );
  assert.ok(starts.every((start) => start >= 1 && start + 99 <= denseSeedRows));
  // Deterministic distribution guard against accidental sequential or fixed keys.
  const regions = new Set(starts.map((start) => Math.floor((start / denseSeedRows) * 100)));
  assert.ok(regions.size >= 95, `only ${regions.size} of 100 table regions sampled`);
});

test("the selected existing native range branch is one bounded NO-LOCK pass without LOB fetches or writes", () => {
  scenario();
  const source = fs
    .readFileSync("openedge/workloads/Workloads/ParkBench/bank_mix.p", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const range = source.split('WHEN "range" THEN DO:')[1]?.split('WHEN "audit-write-cycle"')[0];
  assert.ok(range);
  assert.match(range, /FOR EACH DebitTransaction NO-LOCK/);
  assert.match(range, /BY DebitTransaction\.DebitTransactionId/);
  assert.match(range, /IF rowCount >= 100 THEN LEAVE/);
  assert.match(range, /keySequence MODULO/);
  assert.doesNotMatch(
    range,
    /COPY-LOB|LOBFields|ETIME|DO WHILE|EXCLUSIVE-LOCK|\bCREATE\b|\bDELETE\b|\bTRANSACTION\b/i
  );
});

test("stable reads are available through file discovery and idempotent bundled registration", () => {
  const sources = new ScenarioFileSource(path.resolve("examples/scenarios"));
  const found = sources.getByDeclaredId(scenarioId, "1.0.0");
  assert.equal(found.entry.sourceStatus, "AVAILABLE");
  assert.equal(found.entry.relativePath, `${scenarioId}.json`);
  assert.deepEqual(found.scenario, scenario());
  const catalog = new ScenarioCatalog();
  registerBundledScenarios(catalog);
  registerBundledScenarios(catalog);
  assert.deepEqual(catalog.get(scenarioId, "1.0.0"), scenario());
  assert.equal(catalog.list({ id: scenarioId }).length, 1);
});
