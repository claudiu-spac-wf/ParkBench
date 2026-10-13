import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { validateHostEnvironmentProfile } from "../../packages/contracts/src/host-environment";

const requireFromRepository = createRequire(path.join(process.cwd(), "package.json"));
const { collectHostEnvironment } = requireFromRepository(
  path.join(process.cwd(), "scripts/host-preflight.mjs")
);

const RELEASE = [
  "ID=ubuntu",
  'VERSION_ID="26.04"',
  "VERSION_CODENAME=resolute",
  'PRETTY_NAME="Ubuntu 26.04.1 LTS"'
].join("\n");

describe("platform environment preflight", () => {
  it("accepts the supported host and records varying non-Node tool versions", async () => {
    const fixture = createFixture({
      npmVersion: "99.1.2",
      dockerVersion: "101.2.3",
      composeVersion: "8.4.0"
    });
    const profile = await collectHostEnvironment(fixture.dependencies);

    assert.equal(profile.status, "ready");
    assert.equal(profile.contractVersion, "host-environment.v1");
    assert.equal(profile.host.osRelease, "26.04.1 LTS");
    assert.equal(profile.host.architecture, "x86_64");
    assert.equal(profile.toolchain.node, "24.21.0");
    assert.equal(profile.toolchain.npm, "99.1.2");
    assert.equal(profile.toolchain.dockerClient, "101.2.3");
    assert.equal(profile.toolchain.compose, "8.4.0");
    assert.equal(profile.engine.reachable, true);
    assert.equal(profile.engine.contextName, null);
    assert.equal(profile.engine.endpointKind, null);
    assert.equal("identity" in profile.engine, false);
    assert.equal(profile.checks.find((check) => check.id === "port_cadvisor")?.observed, 18080);
    assert.equal(validateHostEnvironmentProfile(profile).status, "ready");
  });

  it("checks the operator-configured cAdvisor UI host port", async () => {
    const fixture = createFixture({
      env: { PARKBENCH_CADVISOR_HOST_PORT: "18081" },
      occupiedPorts: [18081]
    });
    const profile = await collectHostEnvironment(fixture.dependencies);
    const check = profile.checks.find((entry) => entry.id === "port_cadvisor");

    assert.equal(check?.status, "fail");
    assert.equal(check?.diagnosticCode, "required_port_unavailable");
    assert.equal(check?.observed, undefined);
    assert.ok(
      fixture.commands.some(
        ({ command, args }) =>
          command === "docker" &&
          args.includes("port") &&
          args.includes("cadvisor") &&
          args.includes("8080")
      ),
      "preflight should identify an existing cAdvisor listener as ParkBench-owned when mapped"
    );
  });

  it("rejects Node.js 23 while keeping the observed version in a blocked profile", async () => {
    const fixture = createFixture({ nodeVersion: "v23.11.0" });
    const profile = await collectHostEnvironment(fixture.dependencies);

    assert.equal(profile.status, "blocked");
    assert.equal(validateHostEnvironmentProfile(profile).status, "blocked");
    assert.equal(profile.toolchain.node, "23.11.0");
    assert.equal(
      profile.checks.find((check) => check.id === "node_version")?.diagnosticCode,
      "node_version_unsupported"
    );
  });

  it("fails safely when the local Linux Engine is denied", async () => {
    const fixture = createFixture({ engineDenied: true });
    const profile = await collectHostEnvironment(fixture.dependencies);

    assert.equal(profile.status, "blocked");
    assert.equal(profile.engine.reachable, false);
    assert.equal(
      profile.checks.find((check) => check.id === "docker_engine_access")?.status,
      "fail"
    );
    assert.doesNotMatch(
      JSON.stringify(profile),
      /var\/run\/docker\.sock|claudius|permission denied/i
    );
  });

  it("accepts an accessible Engine without storing its ID", async () => {
    const fixture = createFixture({ engineIdMissing: true });
    const profile = await collectHostEnvironment(fixture.dependencies);
    assert.equal(profile.status, "ready");
    assert.equal(profile.engine.identity, undefined);
    assert.equal(
      profile.checks.find((check) => check.id === "docker_engine_access")?.status,
      "pass"
    );
  });

  it("accepts the operator-selected Docker target without checking a context name or system service", async () => {
    const fixture = createFixture({
      contextName: "default",
      env: { DOCKER_CONTEXT: "operator-context", DOCKER_HOST: "tcp://operator-selected:2375" }
    });
    const profile = await collectHostEnvironment(fixture.dependencies);

    assert.equal(profile.status, "ready");
    assert.equal(profile.engine.contextName, null);
    assert.equal(
      profile.checks.some((check) => check.id === "docker_context"),
      false
    );
    assert.equal(
      profile.checks.some((check) => check.id === "standalone_engine_inactive"),
      false
    );
    assert.equal(
      fixture.commands.some(
        ({ command, args }) =>
          (command === "docker" && args[0] === "context") || command === "systemctl"
      ),
      false
    );
  });

  it("blocks malformed or overlapping CPU affinity groups with a safe setting name", async () => {
    const fixture = createFixture({
      env: { PARKBENCH_PLATFORM_CPUSET: "0-3", PARKBENCH_DB_CPUSET: "3,4" }
    });
    const profile = await collectHostEnvironment(fixture.dependencies);
    assert.equal(profile.status, "blocked");
    assert.equal(
      profile.checks.find((check) => check.id === "cpu_affinity_config")?.diagnosticCode,
      "cpu_affinity_invalid"
    );
    assert.equal(
      profile.checks.find((check) => check.id === "cpu_affinity_config")?.observed,
      "PARKBENCH_DB_CPUSET"
    );
  });

  it("checks npm registry reachability without exposing registry output", async () => {
    const fixture = createFixture({ npmPingFailure: true });
    const profile = await collectHostEnvironment(fixture.dependencies);
    const output = JSON.stringify(profile);

    assert.equal(profile.status, "blocked");
    assert.equal(
      profile.checks.find((check) => check.id === "npm_registry")?.diagnosticCode,
      "npm_registry_unreachable"
    );
    assert.doesNotMatch(output, /private-token|registry\.private\.example|raw npm output/i);
  });

  it("reports missing npm, Docker, and Compose commands with stable safe checks", async () => {
    const fixture = createFixture({ npmMissing: true, dockerMissing: true, composeMissing: true });
    const profile = await collectHostEnvironment(fixture.dependencies);

    assert.equal(profile.status, "blocked");
    for (const id of [
      "npm_command",
      "docker_cli",
      "compose_plugin",
      "docker_engine_access",
      "compose_config"
    ]) {
      assert.equal(profile.checks.find((check) => check.id === id)?.status, "fail", id);
    }
    assert.doesNotMatch(JSON.stringify(profile), /command not found|private\.registry|\/home\//i);
  });

  it("captures only a bounded compiler version token or warns when reporting is unavailable", async () => {
    const reported = createFixture({ compilerVersion: "ParkBench adapter v1.7.3\nprivate-token" });
    const profile = await collectHostEnvironment(reported.dependencies);
    assert.equal(profile.toolchain.compilerAdapterVersion, "1.7.3");
    assert.doesNotMatch(JSON.stringify(profile), /private-token/);

    const unavailable = createFixture({ compilerVersionUnavailable: true });
    const warningProfile = await collectHostEnvironment(unavailable.dependencies);
    assert.equal(warningProfile.status, "ready");
    assert.equal(warningProfile.toolchain.compilerAdapterVersion, null);
    assert.equal(
      warningProfile.checks.find((check) => check.id === "compiler_adapter_version")?.status,
      "warning"
    );
  });

  it("records the OS and reports missing paths, permissions, low space, and port conflicts", async () => {
    const fixture = createFixture({
      osReleaseText: RELEASE.replace("26.04.1 LTS", "24.04.4 LTS").replace("26.04", "24.04"),
      compilerExecutable: false,
      freeBytes: 0,
      occupiedPorts: [13002],
      env: {
        PARKBENCH_OPENEDGE_PROGRESS_ROOT: "../missing-assets",
        PARKBENCH_DOCKER_HOST_PATH_ROOT: "../different-data-root"
      }
    });
    fs.rmSync(fixture.licensePath);
    const profile = await collectHostEnvironment(fixture.dependencies);

    assert.equal(profile.status, "blocked");
    for (const id of [
      "host_data_root",
      "progress_assets",
      "license_input",
      "compiler_adapter",
      "disk_space",
      "port_web_ui"
    ]) {
      assert.equal(profile.checks.find((check) => check.id === id)?.status, "fail", id);
    }
  });

  it("defaults the Docker host path root to the effective host data root", async () => {
    const fixture = createFixture({
      env: {
        PARKBENCH_HOST_DATA_ROOT: "local data root",
        PARKBENCH_DOCKER_HOST_PATH_ROOT: ""
      }
    });
    const profile = await collectHostEnvironment(fixture.dependencies);
    assert.equal(profile.checks.find((check) => check.id === "host_data_root")?.status, "pass");
  });

  it("normalizes Compose host paths before validating the platform model", async () => {
    const fixture = createFixture({
      env: {
        PARKBENCH_HOST_DATA_ROOT: "custom data root",
        PARKBENCH_DOCKER_HOST_PATH_ROOT: "",
        PARKBENCH_PROMETHEUS_TARGET_DIR: "prometheus targets",
        PARKBENCH_DOCKER_SOCKET_PATH: "docker sockets/engine.sock"
      }
    });
    fs.mkdirSync(path.join(fixture.root, "custom data root"), { recursive: true });
    const profile = await collectHostEnvironment(fixture.dependencies);
    const configCall = fixture.commands.find(
      ({ command, args }) => command === "docker" && args.at(-2) === "config"
    );

    assert.equal(profile.checks.find((check) => check.id === "compose_config")?.status, "pass");
    assert.ok(configCall, "host preflight should validate Compose configuration");
    assert.equal(configCall.environment?.PARKBENCH_ENV_FILE, path.join(fixture.root, ".env.local"));
    assert.equal(
      configCall.environment?.PARKBENCH_COMPOSE_FILE,
      path.join(fixture.root, "deploy/platform-compose.yml")
    );
    assert.equal(
      configCall.environment?.PARKBENCH_HOST_DATA_ROOT,
      path.join(fixture.root, "custom data root")
    );
    assert.equal(
      configCall.environment?.PARKBENCH_DOCKER_HOST_PATH_ROOT,
      path.join(fixture.root, "custom data root")
    );
    assert.equal(
      configCall.environment?.PARKBENCH_PROMETHEUS_TARGET_DIR,
      path.join(fixture.root, "prometheus targets")
    );
    assert.equal(
      configCall.environment?.PARKBENCH_DOCKER_SOCKET_PATH,
      path.join(fixture.root, "docker sockets/engine.sock")
    );
  });

  it("rejects a data root whose existing parent is not a directory", async () => {
    const fixture = createFixture();
    const file = path.join(fixture.root, "not-a-directory");
    fs.writeFileSync(file, "fixture");
    const profile = await collectHostEnvironment({
      ...fixture.dependencies,
      env: {
        ...fixture.dependencies.env,
        PARKBENCH_HOST_DATA_ROOT: path.join(file, "child"),
        PARKBENCH_DOCKER_HOST_PATH_ROOT: path.join(file, "child")
      }
    });
    assert.equal(profile.checks.find((check) => check.id === "host_data_root")?.status, "fail");
  });
});

function createFixture(overrides: Record<string, unknown> = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-host-preflight-"));
  const root = path.join(base, "ParkBench");
  const assets = path.join(base, "IMAGES");
  const licensePath = path.join(base, "progress.cfg");
  const compilerPath = path.join(base, "compiler-adapter.sh");
  const dataRoot = path.join(root, ".parkbench");
  fs.mkdirSync(path.join(root, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(root, "openedge/workloads/Workloads"), { recursive: true });
  fs.mkdirSync(path.join(assets, "DATABASE", "PASOE"), { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(root, ".env.local"), "PRIVATE_INPUT=private-token\n");
  fs.writeFileSync(path.join(root, "deploy/platform-compose.yml"), "services: {}\n");
  fs.writeFileSync(licensePath, "LICENSE_CONTENT_MUST_NOT_APPEAR\n");
  fs.writeFileSync(compilerPath, "#!/bin/sh\nexit 0\n", {
    mode: overrides.compilerExecutable === false ? 0o644 : 0o755
  });

  const env = {
    PARKBENCH_ENV_FILE: ".env.local",
    PARKBENCH_HOST_DATA_ROOT: ".parkbench",
    PARKBENCH_OPENEDGE_PROGRESS_ROOT: "../IMAGES",
    PARKBENCH_OPENEDGE_LICENSE_PATH: "../progress.cfg",
    PARKBENCH_OPENEDGE_WORKLOAD_ROOT: "openedge/workloads/Workloads",
    PARKBENCH_OPENEDGE_COMPILER: compilerPath,
    PARKBENCH_OPENEDGE_DB_BASE_IMAGE: "private.registry/db:12.8",
    PARKBENCH_OPENEDGE_PAS_BASE_IMAGE: "private.registry/pas:12.8",
    PARKBENCH_OPENEDGE_JDK_IMAGE: "private.registry/jdk:17",
    PARKBENCH_OPENEDGE_JDK_PATH: "/usr/lib/jvm",
    PARKBENCH_BIND_ADDRESS: "127.0.0.1",
    PARKBENCH_CONTROL_PLANE_HOST_PORT: "13000",
    PARKBENCH_WEB_HOST_PORT: "13002",
    PARKBENCH_GRAFANA_HOST_PORT: "13001",
    PARKBENCH_PROMETHEUS_HOST_PORT: "19090",
    PARKBENCH_CADVISOR_HOST_PORT: "18080",
    ...((overrides.env ?? {}) as Record<string, string>)
  };
  const commands: Array<{ command: string; args: string[]; environment?: NodeJS.ProcessEnv }> = [];
  const runCommand = (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv } = {}
  ) => {
    commands.push({
      command,
      args: [...args],
      ...(options.env ? { environment: { ...options.env } } : {})
    });
    const joined = args.join(" ");
    if (overrides.npmMissing && command === "npm")
      return { status: 127, stdout: "", stderr: "command not found" };
    if (overrides.dockerMissing && command === "docker")
      return { status: 127, stdout: "", stderr: "command not found" };
    if (overrides.composeMissing && command === "docker" && args[0] === "compose")
      return { status: 127, stdout: "", stderr: "command not found" };
    if (command === "npm" && joined === "--version")
      return result(String(overrides.npmVersion ?? "11.19.0"));
    if (command === "npm" && args[0] === "ping")
      return overrides.npmPingFailure
        ? {
            status: 1,
            stdout: "",
            stderr: "raw npm output https://user:private-token@registry.private.example"
          }
        : result("PING succeeded https://registry.npmjs.org/");
    if (command === "docker" && args[0] === "--version")
      return result(`Docker version ${String(overrides.dockerVersion ?? "29.8.1")}, build fixture`);
    if (command === "docker" && args[0] === "compose" && args[1] === "version")
      return result(`Docker Compose version v${String(overrides.composeVersion ?? "5.5.1")}`);
    if (command === "docker" && args[0] === "info")
      return args.includes("{{.ID}}")
        ? overrides.engineIdMissing
          ? { status: 1, stdout: "", stderr: "Engine ID unavailable" }
          : result("fixture-engine-id")
        : overrides.engineDenied
          ? { status: 1, stdout: "", stderr: "permission denied /var/run/docker.sock" }
          : result("29.8.1|linux|x86_64");
    if (command === "docker" && args[0] === "image") return result("[]");
    if (command === "docker" && args[0] === "compose" && args.includes("config")) return result("");
    if (command === "docker" && args[0] === "compose" && args.includes("ps")) return result("");
    if (command === compilerPath && args[0] === "--version")
      return overrides.compilerVersionUnavailable
        ? { status: 1, stdout: "", stderr: "unsupported option" }
        : result(String(overrides.compilerVersion ?? "ParkBench adapter v1.2.0"));
    return { status: 127, stdout: "", stderr: "command not found" };
  };

  const dependencies = {
    root,
    env,
    nodeVersion: String(overrides.nodeVersion ?? "v24.21.0"),
    architecture: "x64",
    kernel: "7.0.0-test",
    osReleaseText: String(overrides.osReleaseText ?? RELEASE),
    freeBytes: Number(overrides.freeBytes ?? 80 * 1024 ** 3),
    meminfoText: overrides.meminfoText ?? "MemAvailable: 16777216 kB",
    runCommand,
    portInUse: async (_host: string, port: number) =>
      ((overrides.occupiedPorts ?? []) as number[]).includes(port),
    now: () => new Date("2026-09-23T10:00:00.000Z")
  };
  return { dependencies, licensePath, root, commands };
}

function result(stdout: string) {
  return { status: 0, stdout, stderr: "" };
}
