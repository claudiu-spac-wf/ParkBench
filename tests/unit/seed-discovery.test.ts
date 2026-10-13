import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagedRootFileDiscovery } from "../../apps/control-plane/src/catalog/file-discovery";
import { createSeedFixture } from "../helpers/seed";

describe("seed catalog discovery (on-disk databases)", () => {
  it("lists one asset per database folder and ignores dot folders, loose files and other folders", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-seed-discovery-"));
    try {
      createSeedFixture(root, "one_gb_lnx");
      createSeedFixture(root, "ten_gb");
      createSeedFixture(path.join(root, ".one_gb_lnx-work"), "source");
      fs.writeFileSync(path.join(root, "loose-seed.tar.gz"), "archive");
      fs.mkdirSync(path.join(root, "no-database"));
      const result = new ManagedRootFileDiscovery({ seeds: root }).discoverRoot("seeds");
      assert.equal(result.state, "READY");
      assert.deepEqual(result.items.map((item) => item.name).sort(), ["one_gb_lnx", "ten_gb"]);
      const seed = result.items.find((item) => item.name === "one_gb_lnx")!;
      assert.equal(seed.kind, "seed");
      assert.equal(seed.immutableRef, "input:seeds/one_gb_lnx");
      assert.equal(seed.readiness, "READY");
      assert.equal(seed.compatibility.databaseName, "parkbench");
      assert.ok(Number(seed.compatibility.sizeBytes) > 0);
      assert.deepEqual(seed.provenance, {
        source: "filesystem",
        rootKey: "seeds",
        relativePath: "one_gb_lnx"
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an unusable database folder visible but not selectable, with its failed rule", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-seed-discovery-"));
    try {
      // A Windows-built source folder: extra license, log and spool files make it unusable as a seed.
      const windows = createSeedFixture(root, "one_gb_win");
      fs.writeFileSync(path.join(windows, "parkbench.lic"), "license");
      const broken = createSeedFixture(root, "broken");
      fs.rmSync(path.join(broken, "parkbench_14.d1"));
      const result = new ManagedRootFileDiscovery({ seeds: root }).discoverRoot("seeds");
      assert.equal(result.state, "DEGRADED");
      const byName = Object.fromEntries(result.items.map((item) => [item.name, item]));
      assert.equal(byName.one_gb_win.readiness, "NOT_READY");
      assert.deepEqual(byName.one_gb_win.blockReasons, ["seed_database_invalid:file:parkbench.lic"]);
      assert.deepEqual(byName.broken.blockReasons, ["seed_database_files_missing:parkbench_14.d1"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
