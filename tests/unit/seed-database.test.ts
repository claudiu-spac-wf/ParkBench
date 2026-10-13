import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStructureFile, validateSeedDirectory } from "../../packages/contracts/src/seed";
import { checkInputReference } from "../../packages/compose-runner/src/input-checks";
import { createSeedFixture } from "../helpers/seed";

function withRoot(callback: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-seed-dir-"));
  try {
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("on-disk seed databases", () => {
  it("derives extent files from the ParkBenchDB structure file", () => {
    const extents = parseStructureFile(
      fs.readFileSync("tests/fixtures/seeds/parkbench.st", "utf8"),
      "parkbench"
    );
    assert.deepEqual(
      extents.map((extent) => extent.file),
      [
        "parkbench.b1",
        "parkbench.d1",
        ...Array.from({ length: 14 }, (_, i) => `parkbench_${i + 7}.d1`)
      ]
    );
    assert.ok(extents.every((extent) => extent.path === "."));
    assert.deepEqual(
      parseStructureFile('d "A":7,64;8 . f 1024\nd "A":7,64;8 .\n', "db").map(
        (extent) => extent.file
      ),
      ["db_7.d1", "db_7.d2"]
    );
  });

  it("describes a valid seed folder by its database file", () => {
    withRoot((root) => {
      const seed = createSeedFixture(root, "one_gb_lnx", { startupPf: "-B 500\n" });
      const described = validateSeedDirectory(seed);
      assert.equal(described.name, "one_gb_lnx");
      assert.equal(described.databaseName, "parkbench");
      assert.equal(
        described.sizeBytes,
        fs.readdirSync(seed).reduce((total, file) => total + fs.statSync(path.join(seed, file)).size, 0)
      );
      assert.equal(validateSeedDirectory(createSeedFixture(root, "bank", { databaseName: "bank" })).databaseName, "bank");
    });
  });

  it("rejects folders that are not a single relocatable database", () => {
    withRoot((root) => {
      const seed = createSeedFixture(root);
      fs.writeFileSync(path.join(seed, "parkbench.lic"), "license");
      assert.throws(() => validateSeedDirectory(seed), /seed_database_invalid:file:parkbench\.lic/);
      fs.rmSync(path.join(seed, "parkbench.lic"));

      fs.mkdirSync(path.join(seed, "pbgen-spool"));
      assert.throws(() => validateSeedDirectory(seed), /seed_database_invalid:subfolder:pbgen-spool/);
      fs.rmSync(path.join(seed, "pbgen-spool"), { recursive: true });

      fs.writeFileSync(path.join(seed, "other.db"), "fixture");
      assert.throws(() => validateSeedDirectory(seed), /seed_database_invalid:multiple_databases/);
      fs.rmSync(path.join(seed, "other.db"));

      fs.rmSync(path.join(seed, "parkbench_9.d1"));
      assert.throws(() => validateSeedDirectory(seed), /seed_database_files_missing:parkbench_9\.d1/);
      fs.writeFileSync(path.join(seed, "parkbench_9.d1"), "fixture");

      const st = path.join(seed, "parkbench.st");
      fs.writeFileSync(
        st,
        fs.readFileSync(st, "utf8").replace('d "PB_Ref_Data":7,64;8 .', 'd "PB_Ref_Data":7,64;8 /data')
      );
      assert.throws(() => validateSeedDirectory(seed), /absolute_extent_path:parkbench_7\.d1/);

      const empty = path.join(root, "empty");
      fs.mkdirSync(empty);
      assert.throws(() => validateSeedDirectory(empty), /seed_database_files_missing:<db>\.db/);
      assert.throws(
        () => validateSeedDirectory(createSeedFixture(root, "One GB")),
        /seed_database_invalid:name/
      );
    });
  });

  it("accepts a seed under the seeds root even when that is outside the input root", () => {
    withRoot((root) => {
      const seed = createSeedFixture(path.join(root, "BenchmarkDb"));
      const inputRoot = path.join(root, "ParkBench");
      assert.throws(() => checkInputReference(seed, "seed", inputRoot), /seed_outside_allowed_root/);
      assert.equal(
        checkInputReference(seed, "seed", [inputRoot, path.join(root, "BenchmarkDb")]).location,
        seed
      );
    });
  });
});
