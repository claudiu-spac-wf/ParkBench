import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";

describe("legacy hash storage migration", () => {
  it("removes stored checksum columns when an existing database starts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-hash-migration-"));
    const config = {
      host: "127.0.0.1",
      port: 0,
      dbPath: path.join(root, "parkbench.sqlite"),
      artifactRoot: path.join(root, "artifacts"),
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {}
    };
    try {
      const first = createPlatform(config, { testMode: true });
      await first.startupRecovery;
      const obsoleteColumns = [
        ["artifacts", "sha256"],
        ["control_image_operations", "input_checksums"],
        ["control_image_operations", "output_digest"],
        ["control_previews", "request_sha256"],
        ["control_experiments", "request_sha256"],
        ["control_run_metadata", "variant_fingerprint"]
      ];
      for (const [table, column] of obsoleteColumns)
        first.database.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      first.database.db.exec(
        "CREATE INDEX idx_control_previews_hash ON control_previews(request_sha256)"
      );
      for (const table of [
        "scenarios",
        "control_assets",
        "control_scenarios",
        "control_asset_discovery"
      ])
        first.database.db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, legacy_hash TEXT)`);
      first.close();
      const second = createPlatform(config, { testMode: true });
      await second.startupRecovery;
      for (const [table, column] of obsoleteColumns) {
        const columns = second.database.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>;
        assert.equal(
          columns.some((item) => item.name === column),
          false,
          `${table}.${column}`
        );
      }
      for (const table of [
        "scenarios",
        "control_assets",
        "control_scenarios",
        "control_asset_discovery"
      ])
        assert.equal(
          second.database.db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table),
          undefined
        );
      second.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
