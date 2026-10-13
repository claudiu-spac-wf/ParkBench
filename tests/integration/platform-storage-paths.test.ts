import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../../packages/contracts/src/config";
import { FileDiscovery } from "../../packages/metrics/src/discovery";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { ArtifactStorage } from "../../apps/control-plane/src/artifacts/storage";
import { createTemporaryPathFixture } from "../helpers/environment-fixture";

describe("configured storage paths", () => {
  it("creates database, artifact, run, and Prometheus target files at their effective locations", () => {
    const fixture = createTemporaryPathFixture("parkbench-storage-paths-");
    const root = fixture.resolve("data root");
    const dbPath = path.join(root, "database", "parkbench.sqlite");
    const artifactRoot = path.join(root, "artifacts");
    const runRoot = path.join(root, "runs");
    const targetRoot = path.join(root, "prometheus targets");
    const config = loadConfig({
      PARKBENCH_DB_PATH: dbPath,
      PARKBENCH_ARTIFACT_ROOT: artifactRoot,
      PARKBENCH_RUN_ROOT: runRoot,
      PARKBENCH_PROMETHEUS_TARGET_DIR: targetRoot
    });

    let database: DatabaseClient | undefined;
    try {
      database = new DatabaseClient(config.dbPath);
      database.db.exec("CREATE TABLE path_test (value TEXT)");
      assert.equal(fs.existsSync(dbPath), true);

      const storage = new ArtifactStorage(config.artifactRoot);
      const written = storage.write("run evidence/result.json", "{}");
      assert.equal(
        fs.readFileSync(path.join(artifactRoot, "run evidence/result.json"), "utf8"),
        "{}"
      );
      assert.equal(storage.read("run evidence/result.json").toString("utf8"), "{}");
      assert.equal(written.sizeBytes, 2);

      const runFile = path.join(config.runRoot, "generated-compose.yml");
      fs.mkdirSync(path.dirname(runFile), { recursive: true });
      fs.writeFileSync(runFile, "services: {}\n");
      assert.equal(fs.existsSync(runFile), true);

      const targets = new FileDiscovery(path.join(config.prometheusTargetDir!, "active-runs.json"));
      targets.add("run-storage-path", []);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(targetRoot, "active-runs.json"), "utf8")),
        []
      );
    } finally {
      database?.close();
      fixture.cleanup();
    }
  });
});
