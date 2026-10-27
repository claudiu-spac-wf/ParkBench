import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
test("licensed acceptance cannot submit native requests when backend regression fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-native-gate-"));
  try {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const evidence = path.join(root, "evidence");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/openedge/test-database-reports.mjs",
        "--seed-id",
        "protected-fixture",
        "--api-base",
        "http://127.0.0.1:1",
        "--evidence-dir",
        evidence
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
        encoding: "utf8"
      }
    );
    assert.equal(result.status, 1);
    const record = JSON.parse(fs.readFileSync(path.join(evidence, "acceptance.json"), "utf8"));
    assert.equal(record.backend.unit, "FAIL");
    assert.equal(record.native.status, "NOT_RUN");
    assert.match(result.stderr, /Native reports blocked/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
