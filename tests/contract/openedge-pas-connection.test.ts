import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("docker/openedge-pasoe/apply-db-connection.sh");

describe("PAS database connection applied at start", () => {
  it("sets each ABL application's DB.CONNECTION.PARAMS from the run and is idempotent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-pas-connection-"));
    try {
      const file = path.join(root, "runtime.properties");
      fs.copyFileSync("docker/openedge-pasoe/runtime.properties", file);
      const env = {
        PATH: "/usr/bin:/bin",
        PARKBENCH_PAS_DB_CONNECTION: "-db parkbench -H database -S 20931"
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = spawnSync("/bin/sh", [script, file], { env, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      assert.deepEqual(
        lines.filter((line) => line.includes("DB.CONNECTION.PARAMS")),
        [
          "oepas1.DB.CONNECTION.PARAMS=-db parkbench -H database -S 20931",
          "parkbench.DB.CONNECTION.PARAMS=-db parkbench -H database -S 20931"
        ]
      );
      assert.ok(lines.includes("PAS.HTTP.PORT=8810"));
      const unset = spawnSync("/bin/sh", [script, file], {
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8"
      });
      assert.equal(unset.status, 45);
      assert.match(unset.stderr, /pas_db_connection_unset/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bakes no database connection into the PAS image or runner defaults", () => {
    for (const file of [
      "docker/openedge-pasoe/Dockerfile",
      "docker/openedge-pasoe/runtime.properties",
      "openedge/runner/runtime.properties"
    ])
      assert.doesNotMatch(
        fs.readFileSync(file, "utf8"),
        /-db sports|sports2020|DB\.CONNECTION\.PARAMS=/,
        file
      );
    assert.match(
      fs.readFileSync("docker/openedge-pasoe/entrypoint.sh", "utf8"),
      /parkbench-pasoe-apply-db-connection\.sh \/deploy\/scripts\/config\/runtime\.properties/
    );
  });
});
