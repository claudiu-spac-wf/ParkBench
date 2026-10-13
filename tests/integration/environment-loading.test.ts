import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import inventory from "../fixtures/env-entry-points.json";
import { createFakeDocker } from "../helpers/fake-docker";
import { createTemporaryPathFixture } from "../helpers/environment-fixture";
import { loadConfig } from "../../packages/contracts/src/config";

const root = process.cwd();

function cleanProfileEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.startsWith("PARKBENCH_")) delete result[key];
  delete result.DOCKER_HOST;
  delete result.DOCKER_CONTEXT;
  // Fake Compose must not consume the developer's generated image handoff.
  if (env.FAKE_DOCKER_CALLS)
    result.PARKBENCH_OPENEDGE_OUTPUT_ROOT = path.join(
      path.dirname(env.FAKE_DOCKER_CALLS),
      "isolated-openedge-output"
    );
  return result;
}

describe("repository-local environment bootstrap", () => {
  it("finds a configured local profile from a child directory and preserves process precedence", () => {
    const child = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-cwd-"));
    const envFile = path.join(child, ".env.local");
    fs.writeFileSync(envFile, "PARKBENCH_ENV_TEST_VALUE=file-value\n");
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/run-with-env.mjs"),
        process.execPath,
        "-e",
        "process.stdout.write(process.env.PARKBENCH_ENV_TEST_VALUE)"
      ],
      {
        cwd: child,
        env: {
          ...cleanProfileEnvironment(process.env),
          PARKBENCH_ENV_FILE: envFile,
          PARKBENCH_HOST_DATA_ROOT: path.join(child, "host-data")
        },
        encoding: "utf8"
      }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "file-value");

    const overridden = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/run-with-env.mjs"),
        process.execPath,
        "-e",
        "process.stdout.write(process.env.PARKBENCH_ENV_TEST_VALUE)"
      ],
      {
        cwd: child,
        env: {
          ...cleanProfileEnvironment(process.env),
          PARKBENCH_ENV_FILE: envFile,
          PARKBENCH_HOST_DATA_ROOT: path.join(child, "host-data"),
          PARKBENCH_ENV_TEST_VALUE: "process-value"
        },
        encoding: "utf8"
      }
    );
    assert.equal(overridden.status, 0);
    assert.equal(overridden.stdout, "process-value");
  });

  it("covers every npm entry point with the environment wrapper", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    for (const entry of inventory.npm) {
      assert.equal(typeof packageJson.scripts[entry], "string", entry);
      assert.match(packageJson.scripts[entry], /scripts\/run-with-env\.mjs/, entry);
    }
  });

  it("covers every shell entry point with the shared environment bootstrap", () => {
    const common = fs.readFileSync(path.join(root, "scripts/lib/common.sh"), "utf8");
    assert.match(common, /load-env\.cjs/);
    for (const entry of inventory.shell) {
      if (entry === "scripts/lib/common.sh") continue;
      const source = fs.readFileSync(path.join(root, entry), "utf8");
      assert.match(source, /source ["']?\$SCRIPT_DIR\/lib\/common\.sh/);
    }
  });

  it("covers every direct entry point with a startup environment loader", () => {
    const stageInputs = fs.readFileSync(
      path.join(root, "scripts/openedge/stage-inputs.mjs"),
      "utf8"
    );
    for (const entry of inventory.direct) {
      const source = fs.readFileSync(path.join(root, entry), "utf8");
      const bootstrapsDirectly = /load-env\.cjs|loadLocalEnvironment/.test(source);
      const bootstrapsThroughStageInputs =
        entry.endsWith("scripts/openedge/package-runner.mjs") &&
        /stage-inputs\.mjs/.test(source) &&
        /load-env\.cjs/.test(stageInputs);
      assert.equal(bootstrapsDirectly || bootstrapsThroughStageInputs, true, entry);
    }
  });

  it("keeps the authoritative entry-point inventory present", () => {
    for (const entry of inventory.direct)
      assert.equal(fs.existsSync(path.join(root, entry)), true, entry);
    for (const entry of inventory.shell)
      assert.equal(fs.existsSync(path.join(root, entry)), true, entry);
  });

  it("passes the selected environment file and effective process values through Compose from another directory", () => {
    const fixture = createTemporaryPathFixture("parkbench-compose-env-");
    const docker = createFakeDocker();
    try {
      const envFile = fixture.resolve("operator profile.env");
      const socketPath = fixture.resolve("docker api.sock");
      fs.writeFileSync(
        envFile,
        `PARKBENCH_AUDIT_SENTINEL=file-value\nPARKBENCH_DOCKER_SOCKET_PATH=${socketPath}\n`
      );
      const selectedProfileEnv = cleanProfileEnvironment(docker.env);
      delete selectedProfileEnv.PARKBENCH_DOCKER_SOCKET_PATH;
      const result = spawnSync(
        "bash",
        [path.join(root, "scripts/compose.sh"), "config", "--format", "json"],
        {
          cwd: fixture.root,
          env: {
            ...selectedProfileEnv,
            PARKBENCH_ENV_FILE: path.relative(root, envFile),
            PARKBENCH_HOST_DATA_ROOT: fixture.resolve("host-data"),
            PARKBENCH_AUDIT_SENTINEL: "process-value",
            DOCKER_CONTEXT: "operator-selected-context"
          },
          encoding: "utf8"
        }
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(docker.calls().length, 1);
      const [call] = docker.calls();
      assert.equal(call.cwd, root);
      assert.deepEqual(call.args.slice(0, 4), ["compose", "--env-file", envFile, "-f"]);
      assert.deepEqual(call.args.slice(-3), ["config", "--format", "json"]);
      assert.equal(call.env.PARKBENCH_AUDIT_SENTINEL, "process-value");
      assert.equal(call.env.PARKBENCH_DOCKER_SOCKET_PATH, socketPath);
      assert.equal(call.env.DOCKER_CONTEXT, "operator-selected-context");

      const compose = fs.readFileSync(path.join(root, "deploy/platform-compose.yml"), "utf8");
      assert.match(compose, /\$\{PARKBENCH_ENV_FILE[^}]*\}:[^\n]*:ro/);
    } finally {
      docker.cleanup();
      fixture.cleanup();
    }
  });

  it("maps generated OpenEdge inputs into the control-plane mount and rejects external paths", () => {
    const fixture = createTemporaryPathFixture("parkbench-generated-input-map-");
    const docker = createFakeDocker();
    try {
      const dataRoot = fixture.resolve("docker data root");
      const inputRoot = path.join(dataRoot, "openedge inputs");
      fs.mkdirSync(inputRoot, { recursive: true });
      const envFile = fixture.resolve("operator.env");
      const appArchive = path.join(inputRoot, "application archive.zip");
      const manifest = path.join(inputRoot, "image manifest.json");
      fs.writeFileSync(
        envFile,
        [
          `PARKBENCH_HOST_DATA_ROOT=${dataRoot}`,
          `PARKBENCH_DOCKER_HOST_PATH_ROOT=${dataRoot}`,
          `PARKBENCH_OPENEDGE_APP_ARCHIVE=${appArchive}`,
          `PARKBENCH_OPENEDGE_IMAGE_MANIFEST=${manifest}`
        ].join("\n") + "\n"
      );
      const selectedProfileEnv = cleanProfileEnvironment(docker.env);
      delete selectedProfileEnv.PARKBENCH_HOST_DATA_ROOT;
      delete selectedProfileEnv.PARKBENCH_DOCKER_HOST_PATH_ROOT;
      delete selectedProfileEnv.PARKBENCH_OPENEDGE_APP_ARCHIVE;
      delete selectedProfileEnv.PARKBENCH_OPENEDGE_IMAGE_MANIFEST;
      const result = spawnSync(
        "bash",
        [path.join(root, "scripts/compose.sh"), "config", "--quiet"],
        {
          cwd: fixture.root,
          env: {
            ...selectedProfileEnv,
            PARKBENCH_ENV_FILE: envFile,
            PARKBENCH_HOST_DATA_ROOT: fixture.resolve("host-data"),
            DOCKER_CONTEXT: "operator-selected-context"
          },
          encoding: "utf8"
        }
      );
      assert.equal(result.status, 0, result.stderr);
      const [call] = docker.calls();
      // Seeds are catalog directories under the seeds root, not a mapped path setting.
      assert.equal(call.env.PARKBENCH_CONTROL_PLANE_OPENEDGE_SEED_PATH, undefined);
      assert.equal(
        call.env.PARKBENCH_CONTROL_PLANE_OPENEDGE_APP_ARCHIVE,
        "/var/lib/parkbench/openedge inputs/application archive.zip"
      );
      assert.equal(
        call.env.PARKBENCH_CONTROL_PLANE_OPENEDGE_IMAGE_MANIFEST,
        "/var/lib/parkbench/openedge inputs/image manifest.json"
      );
      const controlPlaneConfig = loadConfig(
        {
          PARKBENCH_REPOSITORY_ROOT: fixture.root,
          PARKBENCH_CONTAINER_PATH_ROOT: "/var/lib/parkbench",
          PARKBENCH_DOCKER_HOST_PATH_ROOT: dataRoot,
          PARKBENCH_OPENEDGE_DEFAULT_SEED: "one_gb_lnx",
          PARKBENCH_OPENEDGE_APP_ARCHIVE: call.env.PARKBENCH_CONTROL_PLANE_OPENEDGE_APP_ARCHIVE,
          PARKBENCH_OPENEDGE_IMAGE_MANIFEST:
            call.env.PARKBENCH_CONTROL_PLANE_OPENEDGE_IMAGE_MANIFEST
        },
        { root: fixture.root }
      );
      assert.equal(controlPlaneConfig.openedge.defaultSeed, "one_gb_lnx");
      assert.equal(controlPlaneConfig.openedge.databaseName, "parkbench");
      assert.equal(
        controlPlaneConfig.openedge.appArchive,
        "/var/lib/parkbench/openedge inputs/application archive.zip"
      );
      assert.equal(
        controlPlaneConfig.openedge.imageManifestPath,
        "/var/lib/parkbench/openedge inputs/image manifest.json"
      );

      const externalEnv = fixture.resolve("external.env");
      fs.writeFileSync(
        externalEnv,
        `PARKBENCH_DOCKER_HOST_PATH_ROOT=${dataRoot}\nPARKBENCH_OPENEDGE_APP_ARCHIVE=${fixture.resolve("outside/runner.zip")}\n`
      );
      const rejected = spawnSync(
        "bash",
        [path.join(root, "scripts/compose.sh"), "config", "--quiet"],
        {
          cwd: fixture.root,
          env: {
            ...selectedProfileEnv,
            PARKBENCH_ENV_FILE: externalEnv,
            DOCKER_CONTEXT: "operator-selected-context"
          },
          encoding: "utf8"
        }
      );
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /PARKBENCH_OPENEDGE_APP_ARCHIVE must resolve inside/);
      assert.doesNotMatch(rejected.stderr, /outside\/runner\.zip/);

      const compose = fs.readFileSync(path.join(root, "deploy/platform-compose.yml"), "utf8");
      assert.match(compose, /PARKBENCH_OPENEDGE_DEFAULT_SEED: \$\{PARKBENCH_OPENEDGE_DEFAULT_SEED/);
      assert.doesNotMatch(compose, /OPENEDGE_SEED_PATH/);
      assert.match(
        compose,
        /PARKBENCH_OPENEDGE_APP_ARCHIVE: \$\{PARKBENCH_CONTROL_PLANE_OPENEDGE_APP_ARCHIVE/
      );
      assert.match(
        compose,
        /PARKBENCH_OPENEDGE_IMAGE_MANIFEST: \$\{PARKBENCH_CONTROL_PLANE_OPENEDGE_IMAGE_MANIFEST/
      );
    } finally {
      docker.cleanup();
      fixture.cleanup();
    }
  });

  it("keeps all Compose-backed build, start, status, log, and stop wrappers on the selected profile", () => {
    const fixture = createTemporaryPathFixture("parkbench-compose-matrix-");
    const docker = createFakeDocker();
    try {
      const envFile = fixture.resolve("operator profile.env");
      fs.writeFileSync(
        envFile,
        `${fs.readFileSync(path.join(root, ".env.example"), "utf8")}\nPARKBENCH_AUDIT_SENTINEL=file-value\n`
      );
      docker.env.FAKE_DOCKER_STDOUT = "127.0.0.1:13000\n";
      const cases = [
        ["scripts/compose.sh", ["config", "--format", "json"]],
        ["scripts/build-images.sh", []],
        ["scripts/start.sh", ["--no-build"]],
        ["scripts/status.sh", []],
        ["scripts/logs.sh", ["--tail", "1", "control-plane"]],
        ["scripts/stop.sh", []]
      ] as const;

      for (const cwd of [root, fixture.root]) {
        for (const [entry, args] of cases) {
          const previousCalls = docker.calls().length;
          const result = spawnSync("bash", [path.join(root, entry), ...args], {
            cwd,
            env: {
              ...cleanProfileEnvironment(docker.env),
              PARKBENCH_ENV_FILE: path.relative(root, envFile),
              PARKBENCH_HOST_DATA_ROOT: fixture.resolve("host-data"),
              PARKBENCH_OPENEDGE_OUTPUT_ROOT: fixture.resolve("isolated-openedge-output"),
              PARKBENCH_AUDIT_SENTINEL: "process-value",
              PARKBENCH_OPENEDGE_JDK_IMAGE: "parkbench/jdk:local",
              DOCKER_CONTEXT: "operator-selected-context"
            },
            encoding: "utf8"
          });
          assert.equal(result.status, 0, `${entry} from ${cwd}: ${result.stderr}`);
          assert.doesNotMatch(`${result.stdout}${result.stderr}`, /file-value|process-value/);
          const calls = docker.calls().slice(previousCalls);
          assert.ok(calls.length > 0, `${entry} must call the selected Docker CLI`);
          for (const call of calls) {
            assert.equal(call.cwd, root, entry);
            assert.deepEqual(call.args.slice(0, 4), ["compose", "--env-file", envFile, "-f"]);
            assert.equal(call.env.PARKBENCH_AUDIT_SENTINEL, "process-value", entry);
            assert.equal(call.env.DOCKER_CONTEXT, "operator-selected-context", entry);
          }
        }
      }
    } finally {
      docker.cleanup();
      fixture.cleanup();
    }
  });

  it("documents only the config-aware Compose wrapper for canonical actions", () => {
    for (const document of ["QUICKSTART.md", "docs/quickstart.md", "docs/operator-runbook.md"]) {
      const markdown = fs.readFileSync(path.join(root, document), "utf8");
      assert.doesNotMatch(markdown, /^\s*docker compose\b/m, document);
      assert.match(markdown, /scripts\/compose\.sh/, document);
    }
  });
});
