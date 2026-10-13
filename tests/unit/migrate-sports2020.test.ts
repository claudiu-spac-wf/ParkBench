import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const script = path.resolve("scripts/openedge/migrate-sports2020.mjs");

function run(dataRoot: string, args: string[] = []): Array<{ path: string; result: string }> {
  const output = execFileSync(process.execPath, [script, "--json", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PARKBENCH_HOST_DATA_ROOT: dataRoot,
      PARKBENCH_OPENEDGE_OUTPUT_ROOT: path.join(dataRoot, "openedge")
    }
  });
  return JSON.parse(output).results.map((item: any) => ({
    path: path.relative(dataRoot, item.path),
    result: item.result
  }));
}

describe("Sports2020 input migration", () => {
  it("lists on dry run, removes stale inputs once, and never touches run history", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-migrate-"));
    try {
      const write = (relative: string, content = "x") => {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content);
      };
      write("seeds/sports2020-seeds.tar.gz");
      write("archives/sports2020-archives.zip");
      write("openedge/stages/generic/seed/sports2020.tar.gz");
      write(
        "openedge/manifest.json",
        JSON.stringify({ schemaVersion: "image-build.v1", imageStage: "final" })
      );
      write("openedge/images.env", "PARKBENCH_OPENEDGE_SEED_PATH=x\n");
      write(
        "openedge/stages/generic/manifest.json",
        JSON.stringify({ schemaVersion: "image-build.v2", databaseName: "parkbench" })
      );
      write("runs/run-1/compose.yml");
      write("artifacts/run-1/summary.json");
      write("parkbench.sqlite");

      const dry = run(root, ["--dry-run"]);
      assert.ok(dry.every((item) => item.result === "would_remove"));
      assert.equal(fs.existsSync(path.join(root, "seeds/sports2020-seeds.tar.gz")), true);

      const removed = run(root);
      assert.deepEqual(removed.map((item) => item.path).sort(), [
        "archives/sports2020-archives.zip",
        "openedge/images.env",
        "openedge/manifest.json",
        "openedge/stages/generic/seed",
        "seeds/sports2020-seeds.tar.gz"
      ]);
      assert.ok(removed.every((item) => item.result === "removed"));
      assert.ok(run(root).every((item) => item.result === "absent"));
      for (const kept of [
        "runs/run-1/compose.yml",
        "artifacts/run-1/summary.json",
        "parkbench.sqlite",
        "openedge/stages/generic/manifest.json"
      ])
        assert.equal(fs.existsSync(path.join(root, kept)), true, kept);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
