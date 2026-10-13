import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("builds the browser using only sources copied by its Docker build stage", () => {
  const root = process.cwd();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-web-image-context-"));
  const dockerfile = fs.readFileSync(path.join(root, "docker/web/Dockerfile"), "utf8");
  const buildStage = dockerfile.split(/\r?\nFROM /)[1];
  assert.ok(buildStage, "web Dockerfile must have a build stage");
  try {
    // Stage the actual COPY inputs, without access to other repository sources.
    // Reuse installed dependencies so this regression needs no Docker or network.
    for (const [, source, destination] of buildStage.matchAll(/^COPY (\S+) (\S+)\s*$/gm)) {
      const sources =
        source === "package*.json"
          ? fs.readdirSync(root).filter((file) => /^package.*\.json$/.test(file))
          : [source];
      for (const file of sources) {
        const target =
          source === "package*.json"
            ? path.join(temporary, destination, file)
            : path.join(temporary, destination);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(path.join(root, file), target, {
          recursive: true,
          filter: (entry) => !["node_modules", "dist"].includes(path.basename(entry))
        });
      }
    }
    fs.symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "dir");
    const result = spawnSync(
      process.execPath,
      [path.join(root, "node_modules/vite/bin/vite.js"), "build"],
      {
        cwd: path.join(temporary, "apps/web"),
        encoding: "utf8",
        timeout: 30_000
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(fs.statSync(path.join(temporary, "apps/web/dist/index.html")).size > 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
