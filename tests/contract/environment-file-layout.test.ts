import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const sections = [
  "Core application and local host bindings",
  "Persistent storage, artifact, and host path mappings",
  "Observability endpoints, retention, targets, and network",
  "Built-in platform runtime and build image references",
  "Catalog discovery roots",
  "Benchmark load-generator and observer image references",
  "OpenEdge private inputs, credentials, and observer settings",
  "OpenEdge build, compiler, JDK, and output settings",
  "OpenEdge database, PAS, port, and generated-manifest defaults"
];

describe("environment file layout", () => {
  it("keeps example and local files aligned to labeled sections", () => {
    const files = [".env.example", ".env.local"].map((file) =>
      fs.readFileSync(path.join(process.cwd(), file), "utf8")
    );
    const orders = files.map((content) =>
      [...content.matchAll(/^# \d+\. (.+)$/gm)].map((match) => match[1])
    );
    assert.deepEqual(orders[0], sections);
    assert.deepEqual(orders[1], sections);
    for (const content of files) {
      const lines = content.split(/\r?\n/);
      let activeSection = "";
      for (const line of lines) {
        const header = line.match(/^# \d+\. (.+)$/);
        if (header) activeSection = header[1];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) assert.ok(activeSection);
      }
    }
    const example = files[0];
    assert.match(example, /PARKBENCH_PROMETHEUS_IMAGE=prom\/prometheus:v3\.5\.0/);
    assert.match(example, /PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL=5s/);
    assert.match(example, /PARKBENCH_IMAGE_TAG=[A-Za-z0-9_.-]+/);
    assert.match(example, /PARKBENCH_NODE_BASE_IMAGE=node:24-bookworm-slim/);
    assert.match(example, /PARKBENCH_OPENEDGE_DEFAULT_SEED=\s*$/m);
    assert.match(example, /PARKBENCH_OPENEDGE_DATABASE_NAME=parkbench$/m);
    assert.doesNotMatch(example, /PARKBENCH_OPENEDGE_SEED_PATH=|SAMPLE_DATABASE/);
    assert.doesNotMatch(example, /PARKBENCH_CREDENTIAL_PAS_TOMCAT=/);
  });

  it("resolves documented direct commands from supported working directories", () => {
    const script = path.join(process.cwd(), "scripts/host-preflight.mjs");
    const fromRoot = spawnSync(process.execPath, [script, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const fromScripts = spawnSync(process.execPath, ["host-preflight.mjs", "--help"], {
      cwd: path.join(process.cwd(), "scripts"),
      encoding: "utf8"
    });
    const fromOpenEdgeScripts = spawnSync(
      process.execPath,
      ["../../scripts/host-preflight.mjs", "--help"],
      {
        cwd: path.join(process.cwd(), "scripts/openedge"),
        encoding: "utf8"
      }
    );
    for (const result of [fromRoot, fromScripts, fromOpenEdgeScripts]) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ParkBench host preflight/);
    }
  });

  it("routes documented Compose examples through the configuration-aware wrapper", () => {
    const documentation = [
      "README.md",
      "QUICKSTART.md",
      "docs/quickstart.md",
      "docs/operator-runbook.md",
      "docs/validation/ubuntu-migration.md",
      "docs/validation/docker-env-path-audit.md",
      "docs/validation/env-image-simplification.md"
    ];
    for (const file of documentation) {
      assert.doesNotMatch(
        fs.readFileSync(path.join(process.cwd(), file), "utf8"),
        /^\s*docker compose\b/m,
        `${file} should use the ParkBench Compose wrapper`
      );
    }
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    assert.match(readme, /\.\/scripts\/start\.sh/);
    assert.match(
      readme,
      /\.\/scripts\/compose\.sh --profile build build loadgen-image observer-image/
    );
    assert.match(readme, /\.\/scripts\/stop\.sh/);
  });

  it("uses case-sensitive native paths, LF script inputs, and tracked executable modes", () => {
    const parser = path.join(process.cwd(), "scripts/lib/load-env.cjs");
    assert.equal(fs.existsSync(parser), true);
    assert.equal(fs.existsSync(path.join(process.cwd(), "scripts/lib/Load-Env.cjs")), false);
    for (const file of [
      "scripts/bootstrap.sh",
      "scripts/build.sh",
      "scripts/start.sh",
      "scripts/openedge/compile-with-db.mjs"
    ]) {
      assert.equal(
        fs.readFileSync(path.join(process.cwd(), file), "utf8").includes("\r\n"),
        false,
        file
      );
      const indexMode = spawnSync("git", ["ls-files", "--stage", file], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      const modeDiff = spawnSync("git", ["diff", "--summary", "--", file], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(indexMode.status, 0);
      assert.equal(modeDiff.status, 0);
      assert.ok(
        /^100755 /.test(indexMode.stdout) || /mode change 100644 => 100755/.test(modeDiff.stdout),
        `${file} must be executable in a clean checkout`
      );
    }
  });
});
