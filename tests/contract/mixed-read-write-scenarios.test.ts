import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateScenario } from "../../packages/contracts/src/validator";
import { validateWorkScenario } from "../../packages/contracts/src/openedge-validation";
import { syntheticImageManifest } from "../helpers/openedge";
import { calibrationFixture } from "../helpers/read-calibration-fixture";
const nativeImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
export const generator = () =>
  nativeImport(
    pathToFileURL(path.resolve("scripts/openedge/generate-benchmark-scenarios.mjs")).href
  );
export const calibration = () =>
  nativeImport(pathToFileURL(path.resolve("scripts/openedge/read-calibration.mjs")).href);

test("committed presets retain the authored overrides and workload readiness accepts every reference", async () => {
  const lib = await calibration(),
    gen = await generator();
  const report = JSON.parse(
    fs.readFileSync("examples/calibrations/parkbench-read-calibration.json", "utf8")
  );
  const manifest = syntheticImageManifest("final");
  const expected = gen.buildScenarios(report);
  const names = new Set(
    expected.flatMap((s: any) => s.workload.operations.map((o: any) => o.bodyTemplate.procName))
  ) as Set<string>;
  for (const procName of names)
    manifest.workloads.push({
      ...manifest.workloads[0],
      procName,
      contract: { path: procName.replace(/\.p$/, ".contract.json") }
    });
  for (const scenario of expected) {
    const actual = JSON.parse(
      fs.readFileSync(path.join("examples/scenarios", scenario.id + ".json"), "utf8")
    );
    const authored = structuredClone(scenario);
    authored.phases = {
      warmupSeconds: 60,
      measurementSeconds: scenario.id === "parkbench-read-mix" ? 180 : 300,
      cooldownSeconds: 30
    };
    if (scenario.id === "parkbench-read-mix") {
      authored.workload.load.concurrency = 35;
      const readWeights: Record<string, number> = {
        "reference-currencies": 24,
        "reference-transaction-types": 18,
        "product-catalog": 18,
        "customer-profiles": 10,
        "account-overview": 12,
        "contact-lookup": 6,
        "debit-history-amounts": 5,
        "card-auth-amounts": 4,
        "credit-history": 4,
        "login-history": 3,
        "audit-review": 2,
        "statement-download": 2,
        "kyc-document-review": 2,
        "customer-notes": 3,
        "staff-directory": 1,
        "statement-notices": 2
      };
      for (const operation of authored.workload.operations) {
        operation.bodyTemplate.input.WhereClause =
          "RandomInt100 <= 100 AND RandomInt100 = {{band}}";
        operation.weight = readWeights[operation.id];
        operation.templateValues.band.max = 75;
      }
    }
    if (scenario.id === "parkbench-read-write-90-10") {
      const writeSettings: Record<string, [number, number]> = {
        "post-debits": [3500, 50],
        "post-credits": [2000, 50],
        "record-card-authorizations": [3700, 100],
        "record-logins": [5000, 10],
        "record-audit-activity": [3000, 500],
        "change-account-balances": [2500, 4],
        "maintain-customer-details": [2500, 10],
        "verify-contact-details": [750, 50],
        "maintain-loan-balances": [2500, 10],
        "refresh-exchange-rates": [740, 2500],
        "maintain-employee-details": [370, 50],
        "add-customer-documents": [1500, 100],
        "add-customer-notes": [1000, 50],
        "replace-document-content": [750, 100],
        "resolve-notes-without-rewriting-text": [740, 50],
        "refresh-statement-notices": [740, 50],
        "re-render-statement-documents": [500, 100]
      };
      for (const operation of authored.workload.operations) {
        const setting = writeSettings[operation.id];
        if (setting) {
          operation.weight = setting[0];
          operation.bodyTemplate.input.Limit = setting[1];
        }
      }
    }
    assert.deepEqual(actual, authored);
    validateScenario(actual);
    validateWorkScenario(actual, manifest);
  }
  lib.validateCalibration(report, { profile: lib.readProfile() });
  // The checked-in files are deliberately tuned. Verify generator/check round trips separately.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-generated-presets-"));
  try {
    gen.generate({ directory });
    gen.generate({ directory, check: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("mixed presets preserve all operations, input payloads and exact conditional/group probabilities", async () => {
  const lib = await calibration(),
    gen = await generator(),
    profile = lib.readProfile();
  const writes = JSON.parse(
    fs.readFileSync("examples/scenarios/parkbench-banking-writes.json", "utf8")
  );
  const scenarios = gen.buildScenarios(calibrationFixture(lib), profile, writes);
  for (const [index, scenario] of scenarios.entries()) {
    validateScenario(scenario);
    assert.deepEqual(scenario.phases, {
      warmupSeconds: 30,
      measurementSeconds: 120,
      cooldownSeconds: 10
    });
    assert.deepEqual(scenario.target, profile.common.target);
    assert.equal(scenario.target.timeoutMs, 60000);
    assert.deepEqual(scenario.workload.load, {
      mode: "constant-concurrency",
      concurrency: 10,
      maxInFlightPerWorker: 1,
      seed: 2026
    });
    assert.deepEqual(scenario.observers, profile.common.observers);
    const operations = scenario.workload.operations;
    assert.equal(operations.length, index ? 33 : 16);
    assert.equal(new Set(operations.map((o: any) => o.id)).size, operations.length);
    for (const [i, op] of operations.slice(0, 16).entries()) {
      assert.deepEqual(
        op.bodyTemplate.input.FieldsList,
        profile.operations[i].bodyTemplate.input.FieldsList
      );
      assert.deepEqual(
        op.bodyTemplate.input.LobFields,
        profile.operations[i].bodyTemplate.input.LobFields
      );
      assert.equal(op.bodyTemplate.input.Limit, 0);
      assert.equal(
        op.bodyTemplate.input.WhereClause,
        "RandomInt1000 <= 1 AND RandomInt1000 = {{band}}"
      );
      assert.deepEqual(op.templateValues.band, { kind: "uniformInt", min: 1, max: 1 });
      assert.ok(
        Math.abs(
          op.weight / operations[0].weight -
            profile.operations[i].weight / profile.operations[0].weight
        ) < 1e-12
      );
    }
    if (index) {
      const [readMultiplier, writeMultiplier, expectedTotal] = [
        [450, 37, 37000],
        [200, 37, 18500],
        [350, 111, 37000]
      ][index - 1];
      assert.ok(operations.every((op: any) => Number.isSafeInteger(op.weight) && op.weight > 0));
      for (const [i, op] of operations.slice(0, 16).entries())
        assert.equal(op.weight, profile.operations[i].weight * readMultiplier);
      for (const [i, op] of operations.slice(16).entries()) {
        const original = writes.workload.operations[i];
        assert.deepEqual({ ...op, weight: original.weight }, original);
        assert.equal(op.weight, original.weight * writeMultiplier);
      }
      const readWeight = operations.slice(0, 16).reduce((s: number, o: any) => s + o.weight, 0);
      const total = operations.reduce((s: number, o: any) => s + o.weight, 0);
      assert.equal(total, expectedTotal);
      assert.equal(readWeight / total, gen.mixes[index - 1].readShare);
    }
  }
});
test("generation check is seed independent, read only and rejects profile/report/output drift", async () => {
  const lib = await calibration(),
    gen = await generator(),
    root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-generator-"));
  try {
    const filename = path.join(root, "calibration.json"),
      directory = path.join(root, "scenarios");
    fs.writeFileSync(filename, JSON.stringify(calibrationFixture(lib)));
    const result = gen.generate({ calibration: filename, directory });
    assert.equal(result.referenceSeed, "reference seed not reverified");
    const before = fs
      .readdirSync(directory)
      .map((name) => fs.readFileSync(path.join(directory, name), "utf8"));
    gen.generate({ calibration: filename, directory, check: true });
    assert.deepEqual(
      fs.readdirSync(directory).map((name) => fs.readFileSync(path.join(directory, name), "utf8")),
      before
    );
    const target = path.join(directory, "parkbench-read-mix.json");
    fs.appendFileSync(target, " ");
    assert.throws(
      () => gen.generate({ calibration: filename, directory, check: true }),
      /scenario_drift/
    );
    assert.ok(fs.readFileSync(target, "utf8").endsWith(" "));
    const report = calibrationFixture(lib);
    report.readProfileHash = "f".repeat(64);
    fs.writeFileSync(filename, JSON.stringify(report));
    assert.throws(() => gen.generate({ calibration: filename, directory }), /stale/);
    assert.ok(fs.readFileSync(target, "utf8").endsWith(" "));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("partition predicates use correlated native bounds without adding operations or changing weights", async () => {
  const lib = await calibration(),
    gen = await generator(),
    profile = lib.readProfile();
  const inventory = JSON.parse(
    fs.readFileSync("scripts/openedge/table-write-inventory.json", "utf8")
  );
  profile.partitionMap = profile.operations.map((o: any) => {
    const t = inventory.tables.find((t: any) => t.name === o.bodyTemplate.input.TableName);
    return {
      operationId: o.id,
      keyFields: [t.primaryField],
      keyTypes: [t.fields.find((f: any) => f.name === t.primaryField).type.toUpperCase()],
      ranges: [
        { lowerInclusive: null, upperExclusive: [100] },
        { lowerInclusive: [100], upperExclusive: null }
      ]
    };
  });
  const report = calibrationFixture(lib, profile),
    ops = gen.readOperations(report, profile);
  assert.equal(ops.length, 16);
  assert.deepEqual(
    ops.map((o: any) => o.weight),
    profile.operations.map((o: any) => o.weight)
  );
  assert.deepEqual(ops[0].templateValues.partition, { kind: "uniformInt", min: 1, max: 2 });
  assert.match(
    ops[0].bodyTemplate.input.WhereClause,
    /\(\{\{partition\}\} = 1 AND \w+ < 100\) OR \(\{\{partition\}\} = 2 AND \w+ >= 100\)/
  );
  report.accessCoverage.partitionMapHash = "d".repeat(64);
  assert.throws(() => gen.readOperations(report, profile), /coverage_mismatch/);
});

test("targeted native acceptance selects an exact known preset and rejects unknown IDs", async () => {
  const { selectScenarios } = await nativeImport(
    pathToFileURL(path.resolve("scripts/openedge/benchmark-scenario-acceptance.mjs")).href
  );
  const lib = await calibration(),
    report = calibrationFixture(lib);
  assert.equal(selectScenarios(report).length, 4);
  const selected = selectScenarios(report, "parkbench-read-write-70-30");
  assert.deepEqual(
    selected.map((s: any) => s.id),
    ["parkbench-read-write-70-30"]
  );
  assert.throws(() => selectScenarios(report, "unknown"), /benchmark_scenario_unknown/);
});
