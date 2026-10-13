import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

describe("Ubuntu bootstrap diagnostic redaction", () => {
  it("removes environment values, credentials, license contents, and private archive/seed contents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-redaction-"));
    const licensePath = path.join(root, "progress.cfg");
    const archivePath = path.join(root, "private-runtime.zip");
    const seedPath = path.join(root, "private-seed.tar.gz");
    fs.writeFileSync(licensePath, "LICENSE_CONTENT_SENTINEL_98765\n");
    fs.writeFileSync(archivePath, "ARCHIVE_CONTENT_SENTINEL_12345\n");
    fs.writeFileSync(seedPath, "SEED_CONTENT_SENTINEL_54321\n");
    fs.writeFileSync(
      path.join(root, ".env.local"),
      [
        "PARKBENCH_SECRET=ENV_SECRET_SENTINEL_12345",
        `PARKBENCH_OPENEDGE_LICENSE_PATH=${licensePath}`,
        `PARKBENCH_PRIVATE_ARCHIVE_PATH=${archivePath}`,
        `PARKBENCH_PRIVATE_SEED_PATH=${seedPath}`
      ].join("\n") + "\n"
    );

    const redactorUrl = pathToFileURL(
      path.join(process.cwd(), "scripts/redact-diagnostics.mjs")
    ).href;
    const script = `
      import { collectSensitiveValues, redactDiagnosticText } from ${JSON.stringify(redactorUrl)};
      const [root, input] = process.argv.slice(1);
      const secrets = collectSensitiveValues(root, { PARKBENCH_ENV_FILE: ".env.local" });
      process.stdout.write(redactDiagnosticText(input, secrets));
    `;
    const raw = [
      "host-preflight registry output: ENV_SECRET_SENTINEL_12345",
      "build output password=console-secret",
      "failed credential https://operator:credential-secret@example.invalid/private",
      `license ${licensePath} LICENSE_CONTENT_SENTINEL_98765`,
      "private archive ARCHIVE_CONTENT_SENTINEL_12345",
      "private seed SEED_CONTENT_SENTINEL_54321",
      "/home/ubuntu/parkbench/progress.cfg"
    ].join("\n");
    const publicProfileFields = {
      valid: false,
      status: "blocked",
      reachable: true,
      observed: 13000
    };
    const inputWithProfile = `${raw}\n${JSON.stringify(publicProfileFields)}`;

    try {
      const redacted = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", script, root, inputWithProfile],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      for (const sentinel of [
        "ENV_SECRET_SENTINEL_12345",
        "console-secret",
        "operator:credential-secret",
        "LICENSE_CONTENT_SENTINEL_98765",
        "ARCHIVE_CONTENT_SENTINEL_12345",
        "SEED_CONTENT_SENTINEL_54321",
        "/home/ubuntu"
      ]) {
        assert.equal(redacted.includes(sentinel), false, sentinel);
      }
      assert.match(redacted, /\[REDACTED\]/);
      assert.match(redacted, /<home>/);
      for (const [field, value] of Object.entries(publicProfileFields)) {
        assert.ok(redacted.includes(JSON.stringify(field)), field);
        assert.ok(redacted.includes(JSON.stringify(value)), `${field} was altered`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps environment conflicts, preflight failures, and path errors free of values and file contents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-safe-path-diagnostics-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-private-outside-"));
    const environmentFile = path.join(root, "operator.env");
    const badRoot = path.join(root, "dangling-data-root");
    const privateContents = "LICENSE_PRIVATE_CONTENT_SENTINEL";
    fs.writeFileSync(path.join(root, "progress.cfg"), privateContents);
    fs.writeFileSync(environmentFile, "PARKBENCH_AUDIT_SECRET=file-private-sentinel\n");
    fs.symlinkSync(path.join(root, "missing-data-root"), badRoot);
    fs.mkdirSync(path.join(root, "data"));
    fs.symlinkSync(outside, path.join(root, "data/escape"), "dir");

    const conflict = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts/lib/load-env.cjs"),
        "--",
        "--root",
        root,
        "--env-file",
        environmentFile,
        "--shell"
      ],
      {
        env: { ...process.env, PARKBENCH_AUDIT_SECRET: "process-private-sentinel" },
        encoding: "utf8"
      }
    );
    const pathError = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts/lib/resolve-paths.cjs"),
        "--root",
        root,
        "--allowed-root",
        path.join(root, "data"),
        "--",
        path.join(root, "data/escape/private.seed")
      ],
      { encoding: "utf8" }
    );
    const requireFromRepository = createRequire(path.join(process.cwd(), "package.json"));
    const { collectHostEnvironment } = requireFromRepository(
      path.join(process.cwd(), "scripts/host-preflight.mjs")
    ) as {
      collectHostEnvironment(dependencies: Record<string, unknown>): Promise<Record<string, any>>;
    };
    const preflight = await collectHostEnvironment({
      root,
      env: {
        PARKBENCH_ENV_FILE: "operator.env",
        PARKBENCH_HOST_DATA_ROOT: badRoot,
        PARKBENCH_DOCKER_HOST_PATH_ROOT: badRoot,
        PARKBENCH_OPENEDGE_LICENSE_PATH: "progress.cfg"
      },
      osReleaseText:
        'ID=ubuntu\nVERSION_ID="26.04"\nVERSION_CODENAME=resolute\nPRETTY_NAME="Ubuntu 26.04.1 LTS"',
      kernel: "fixture-kernel",
      architecture: "x86_64",
      nodeVersion: "24.21.0",
      freeBytes: 50 * 1024 ** 3,
      occupiedPorts: [],
      runCommand: () => ({ status: 1, stdout: "", stderr: privateContents })
    });
    const diagnostics = `${conflict.stderr}\n${pathError.stderr}\n${JSON.stringify(preflight)}`;

    try {
      assert.equal(conflict.status, 0);
      assert.equal(pathError.status, 1);
      assert.match(conflict.stderr, /environment_conflict:PARKBENCH_AUDIT_SECRET/);
      assert.match(pathError.stderr, /path_outside_allowed_root/);
      assert.equal(
        preflight.checks.find((check: any) => check.id === "host_data_root")?.status,
        "fail"
      );
      for (const privateValue of [
        "file-private-sentinel",
        "process-private-sentinel",
        privateContents,
        environmentFile,
        outside
      ])
        assert.equal(diagnostics.includes(privateValue), false, privateValue);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
