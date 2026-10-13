import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("Grafana layout startup fails clearly for an incompatible template", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grafana-template-"));
  try {
    fs.mkdirSync(path.join(root, "views"));
    fs.writeFileSync(path.join(root, "views/index.html"), "template without head");
    const result = spawnSync("sh", [path.resolve("deploy/grafana/frontend/start.sh")], {
      env: { ...process.env, GF_SERVER_STATIC_ROOT_PATH: root, TMPDIR: root },
      encoding: "utf8"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /parkbench_grafana_template_incompatible/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
