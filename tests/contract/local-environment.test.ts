import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { loadOpenEdgeImageEnvironment } from "../../packages/contracts/src/local-env";
import { createTemporaryPathFixture, withEnvironment } from "../helpers/environment-fixture";

const loadEnv = createRequire(__filename);
const { loadEnvironment, parseEnvFile } = loadEnv(
  path.join(process.cwd(), "scripts/lib/load-env.cjs")
);

describe("local environment loading", () => {
  it("parses safe dotenv syntax without interpolation or comment processing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-env-"));
    const file = path.join(root, ".env.local");
    fs.writeFileSync(
      file,
      [
        "# comment",
        "PLAIN= value # retained",
        'SPACED="a value # retained"',
        "SINGLE='a\\b'",
        "EMPTY=",
        ""
      ].join("\n")
    );
    const parsed = parseEnvFile(file);
    assert.deepEqual(parsed.values, {
      PLAIN: "value # retained",
      SPACED: "a value # retained",
      SINGLE: "a\\b",
      EMPTY: ""
    });
  });

  it("rejects duplicate, malformed, and unterminated settings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-env-"));
    for (const [name, contents, code] of [
      ["duplicate", "VALUE=one\nVALUE=two\n", "env_duplicate_setting"],
      ["malformed", "not an assignment\n", "env_assignment_malformed"],
      ["quote", 'VALUE="unterminated\n', "env_unterminated_quote"]
    ] as const) {
      const file = path.join(root, name);
      fs.writeFileSync(file, contents);
      assert.throws(() => parseEnvFile(file), new RegExp(code));
    }
  });

  it("keeps existing process values ahead of file values and tolerates a missing file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-env-"));
    const file = path.join(root, ".env.local");
    fs.writeFileSync(file, "FROM_FILE=file\nFROM_PROCESS=file\n");
    const previous = process.env.FROM_PROCESS;
    process.env.FROM_PROCESS = "process";
    try {
      const loaded = loadEnvironment({ root, envFile: file });
      assert.equal(loaded.values.FROM_FILE, "file");
      assert.equal(process.env.FROM_PROCESS, "process");
      assert.equal(loadEnvironment({ root, envFile: "missing.env" }).exists, false);
    } finally {
      if (previous === undefined) delete process.env.FROM_PROCESS;
      else process.env.FROM_PROCESS = previous;
      delete process.env.FROM_FILE;
    }
  });

  it("reports process-over-file conflicts by key and source without printing either value", async () => {
    const fixture = createTemporaryPathFixture("parkbench-env-conflict-");
    try {
      const envFile = fixture.resolve("alternate.env");
      fs.writeFileSync(envFile, "PARKBENCH_AUDIT_VALUE=file-secret\nFILE_ONLY=file-only\n");
      const loaded = await withEnvironment(
        { PARKBENCH_AUDIT_VALUE: "process-secret", FILE_ONLY: undefined },
        () => loadEnvironment({ root: fixture.root, envFile })
      );

      assert.equal(loaded.values.PARKBENCH_AUDIT_VALUE, "process-secret");
      assert.equal(loaded.sources.PARKBENCH_AUDIT_VALUE, "process_environment");
      assert.equal(loaded.sources.FILE_ONLY, "environment_file");
      assert.deepEqual(loaded.conflicts, [
        {
          key: "PARKBENCH_AUDIT_VALUE",
          sources: ["environment_file", "process_environment"],
          effectiveSource: "process_environment"
        }
      ]);

      const child = spawnSync(
        process.execPath,
        [
          path.join(process.cwd(), "scripts/lib/load-env.cjs"),
          "--",
          "--root",
          fixture.root,
          "--env-file",
          envFile,
          "--shell"
        ],
        {
          cwd: fixture.root,
          env: {
            ...process.env,
            PARKBENCH_AUDIT_VALUE: "process-secret",
            FILE_ONLY: undefined
          },
          encoding: "utf8"
        }
      );
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stderr, /environment_conflict:PARKBENCH_AUDIT_VALUE/);
      assert.match(child.stderr, /environment_file/);
      assert.match(child.stderr, /process_environment/);
      assert.doesNotMatch(child.stderr, /file-secret|process-secret/);
      assert.match(child.stdout, /PARKBENCH_AUDIT_VALUE='process-secret'/);
    } finally {
      fixture.cleanup();
    }
  });

  it("lets generated handoff files override inherited operator image settings", () => {
    const fixture = createTemporaryPathFixture("parkbench-generated-env-");
    try {
      const generatedFile = fixture.resolve("images.env");
      fs.writeFileSync(
        generatedFile,
        [
          "PARKBENCH_OPENEDGE_DB_IMAGE=parkbench/openedge-db:generated",
          'PARKBENCH_OPENEDGE_SEED_PATH="/tmp/generated inputs/seed archive.tar.gz"',
          ""
        ].join("\n")
      );
      const result = spawnSync(
        process.execPath,
        [
          path.join(process.cwd(), "scripts/lib/load-env.cjs"),
          "--",
          "--root",
          fixture.root,
          "--env-file",
          generatedFile,
          "--required",
          "--prefer-file",
          "--shell"
        ],
        {
          cwd: fixture.root,
          env: {
            ...process.env,
            PARKBENCH_OPENEDGE_DB_IMAGE: "parkbench/openedge-db:operator-default",
            PARKBENCH_OPENEDGE_SEED_PATH: "/tmp/operator-default/seed.tar.gz"
          },
          encoding: "utf8"
        }
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PARKBENCH_OPENEDGE_DB_IMAGE='parkbench\/openedge-db:generated'/);
      assert.match(
        result.stdout,
        /PARKBENCH_OPENEDGE_SEED_PATH='\/tmp\/generated inputs\/seed archive\.tar\.gz'/
      );
      assert.match(
        result.stderr,
        /environment_conflict:PARKBENCH_OPENEDGE_DB_IMAGE:.*effective=environment_file/
      );
      assert.doesNotMatch(result.stderr, /operator-default|generated inputs/);
    } finally {
      fixture.cleanup();
    }
  });

  it("loads the generated OpenEdge image handoff through the local environment API", async () => {
    const fixture = createTemporaryPathFixture("parkbench-openedge-handoff-");
    try {
      const generatedFile = fixture.resolve("output/images.env");
      fs.mkdirSync(path.dirname(generatedFile), { recursive: true });
      fs.writeFileSync(
        generatedFile,
        [
          "PARKBENCH_OPENEDGE_DB_IMAGE=parkbench/openedge-db:generated",
          'PARKBENCH_OPENEDGE_SEED_PATH="/tmp/generated inputs/seed archive.tar.gz"',
          ""
        ].join("\n")
      );
      const result = await withEnvironment(
        {
          PARKBENCH_OPENEDGE_DB_IMAGE: "parkbench/openedge-db:operator-default",
          PARKBENCH_OPENEDGE_SEED_PATH: "/tmp/operator-default/seed.tar.gz"
        },
        () => loadOpenEdgeImageEnvironment(fixture.root, "output")
      );

      assert.equal(result.values.PARKBENCH_OPENEDGE_DB_IMAGE, "parkbench/openedge-db:generated");
      assert.equal(
        result.values.PARKBENCH_OPENEDGE_SEED_PATH,
        "/tmp/generated inputs/seed archive.tar.gz"
      );
      assert.deepEqual(
        result.conflicts.map((conflict) => conflict.key).sort(),
        ["PARKBENCH_OPENEDGE_DB_IMAGE", "PARKBENCH_OPENEDGE_SEED_PATH"]
      );
    } finally {
      fixture.cleanup();
    }
  });
});
