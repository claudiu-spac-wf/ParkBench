import test from "node:test";
import assert from "node:assert/strict";
import {
  DATABASE_IOPS_CATALOG,
  resolveDatabaseIops,
  validateDatabaseIopsCondition,
  desiredIops
} from "../../packages/contracts/src/database-iops";
import { parameterPlan, readParameterPlan } from "../../packages/compose-runner/src/parameters";
import { PLATFORM_RUN_PARAMETER_DEFINITIONS } from "../../packages/contracts/src/run-parameters";
import { expandMatrix } from "../../packages/contracts/src/matrix-expansion";
import { iopsCoverage } from "../fixtures/database-iops";
const tiers = [
  ["hdd-t1", "HDD T1", 1000],
  ["hdd-t2", "HDD T2", 2000],
  ["hdd-t3", "HDD T3", 3000],
  ["sata-ssd-t1", "SATA SSD T1", 6000],
  ["sata-ssd-t2", "SATA SSD T2", 20000],
  ["sata-ssd-t3", "SATA SSD T3", 60000],
  ["nvme-t1", "NVME T1", 128000],
  ["nvme-t2", "NVME T2", 256000],
  ["nvme-t3", "NVME T3", 400000],
  ["unlimited", "Unlimited", null]
] as const;
test("revision 2 offers exactly nine finite tiers and unchanged default Unlimited", () => {
  assert.equal(DATABASE_IOPS_CATALOG.contractVersion, "database-iops-presets.v2");
  assert.deepEqual(
    DATABASE_IOPS_CATALOG.presets.map((p) => [
      p.id,
      p.label,
      p.readIopsPerDevice,
      p.writeIopsPerDevice
    ]),
    tiers.map(([id, label, n]) => [id, label, n, n])
  );
  const definition = PLATFORM_RUN_PARAMETER_DEFINITIONS.find(
    (p) => p.canonicalName === "storage.databaseIopsPreset"
  )!;
  assert.deepEqual(
    definition.allowedValues,
    tiers.map((t) => t[0])
  );
  assert.equal(definition.definitionVersion, "2");
  assert.equal(resolveDatabaseIops().presetId, "unlimited");
  for (const [id, , n] of tiers) {
    const c = resolveDatabaseIops(id);
    assert.equal(c.catalogVersion, "database-iops-presets.v2");
    assert.equal(c.readIopsPerDevice, n);
    assert.equal(c.writeIopsPerDevice, n);
    assert.deepEqual(validateDatabaseIopsCondition(JSON.parse(JSON.stringify(c))), c);
    if (n !== null) {
      const rules = desiredIops(c, iopsCoverage(3));
      assert.equal(rules.read.length, 3);
      assert.ok([...rules.read, ...rules.write].every((r) => r.Rate === n));
    }
  }
});
test("saved revision 1 values survive catalog replacement, including queued Unlimited", () => {
  for (const [id, label, n] of [
    ["hdd", "HDD", 150],
    ["sata-ssd", "SATA SSD", 90000],
    ["slow-nvme", "Slow NVME", 250000],
    ["fast-nvme", "Fast NVME", 1000000],
    ["unlimited", "Unlimited", null]
  ] as const) {
    const saved = {
      contractVersion: "database-iops-condition.v1" as const,
      catalogVersion: "database-iops-presets.v1" as const,
      presetId: id,
      label,
      readIopsPerDevice: n,
      writeIopsPerDevice: n
    };
    assert.deepEqual(validateDatabaseIopsCondition(saved), saved);
    const plan = parameterPlan({ "storage.databaseIopsPreset": id }, { databaseIops: saved });
    assert.deepEqual(readParameterPlan(plan).databaseIops, saved);
    assert.deepEqual(plan.databaseStartupArgs, []);
    if (id !== "unlimited")
      assert.throws(() =>
        validateDatabaseIopsCondition({ ...saved, catalogVersion: "database-iops-presets.v2" })
      );
  }
});
test("revision identities cannot be mixed or given arbitrary tier values", () => {
  const c = resolveDatabaseIops("hdd-t1");
  for (const patch of [
    { catalogVersion: "database-iops-presets.v1" },
    { catalogVersion: "future" },
    { presetId: "hdd" },
    { label: "HDD" },
    { readIopsPerDevice: 999 },
    { writeIopsPerDevice: 2000 }
  ])
    assert.throws(() => validateDatabaseIopsCondition({ ...c, ...patch }));
});
test("tier matrices freeze all ten conditions while new preview options exclude retired IDs", () => {
  const request: any = {
    runName: "tiers",
    dimensions: [{ name: "storage.databaseIopsPreset", values: tiers.map((t) => t[0]) }],
    fixedOverrides: {},
    repetitions: 2
  };
  const cells = expandMatrix(request, PLATFORM_RUN_PARAMETER_DEFINITIONS);
  assert.equal(cells.length, 20);
  for (const c of cells) assert.equal(c.databaseIops.catalogVersion, "database-iops-presets.v2");
  for (const id of ["hdd", "sata-ssd", "slow-nvme", "fast-nvme"])
    assert.throws(() =>
      expandMatrix(
        { ...request, dimensions: [{ name: "storage.databaseIopsPreset", values: [id] }] },
        PLATFORM_RUN_PARAMETER_DEFINITIONS
      )
    );
});
