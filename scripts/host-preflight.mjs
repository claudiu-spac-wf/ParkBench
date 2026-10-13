#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnvironment } = require("./lib/load-env.cjs");
const { mapHostPathToContainer, resolveHostPath } = require("./lib/resolve-paths.cjs");
const { validateCpuSetConfiguration } = require("./lib/cpuset.cjs");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINIMUM_FREE_BYTES = 10 * 1024 ** 3;
const PORTS = [
  {
    id: "port_control_plane",
    setting: "PARKBENCH_CONTROL_PLANE_HOST_PORT",
    service: "control-plane",
    target: 3000,
    fallback: 13000
  },
  {
    id: "port_web_ui",
    setting: "PARKBENCH_WEB_HOST_PORT",
    service: "web",
    target: 80,
    fallback: 13002
  },
  {
    id: "port_grafana",
    setting: "PARKBENCH_GRAFANA_HOST_PORT",
    service: "grafana",
    target: 3000,
    fallback: 13001
  },
  {
    id: "port_cadvisor",
    setting: "PARKBENCH_CADVISOR_HOST_PORT",
    service: "cadvisor",
    target: 8080,
    fallback: 18080
  },
  {
    id: "port_prometheus",
    setting: "PARKBENCH_PROMETHEUS_HOST_PORT",
    service: "prometheus",
    target: 9090,
    fallback: 19090
  }
];

export function sanitizeVersion(value) {
  const match = String(value).match(
    /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:$|[^A-Za-z0-9.-])/
  );
  return match?.[1]?.slice(0, 80) ?? null;
}

// MemAvailable excludes RAM occupied by tmpfs files and accounts for reclaimable host cache.
// This is a pressure check, not a guarantee for every Docker VM allocation.
export function hostMemoryCheck(text) {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  const bytes = match ? Number(match[1]) * 1024 : NaN;
  const ready = Number.isSafeInteger(bytes) && bytes >= 2 * 1024 ** 3;
  return {
    status: ready ? "pass" : "fail",
    diagnosticCode: !Number.isSafeInteger(bytes)
      ? "host_memory_unavailable"
      : ready
        ? "host_memory_available"
        : "host_memory_pressure",
    action:
      "Free at least 2 GiB of available host RAM before bootstrap. Check RAM-backed /tmp crash dumps and Docker VM allocation; preserve needed dumps on disk.",
    ...(Number.isSafeInteger(bytes) ? { observed: Math.floor(bytes / 1024 ** 2) } : {})
  };
}

export async function collectHostEnvironment(dependencies = {}) {
  const root = path.resolve(dependencies.root ?? REPO_ROOT);
  const env = dependencies.env ?? process.env;
  const run = dependencies.runCommand ?? runCommand;
  const now = dependencies.now ?? (() => new Date());
  const checks = [];
  const add = (id, status, diagnosticCode, action, observed) => {
    checks.push({
      id,
      status,
      diagnosticCode,
      action,
      ...(observed === undefined ? {} : { observed })
    });
  };
  const memory = hostMemoryCheck(dependencies.meminfoText ?? readText("/proc/meminfo"));
  add("host_memory", memory.status, memory.diagnosticCode, memory.action, memory.observed);
  const cpuSetIssue = validateCpuSetConfiguration(env);
  add(
    "cpu_affinity_config",
    cpuSetIssue ? "fail" : "pass",
    cpuSetIssue ? "cpu_affinity_invalid" : "cpu_affinity_valid",
    "Set valid, non-overlapping Docker CPU sets using CPU IDs such as 0,1,4-7.",
    cpuSetIssue?.setting
  );
  const execute = (command, args, options = {}) => {
    try {
      return run(command, args, { cwd: root, ...options });
    } catch {
      return { status: 127, stdout: "", stderr: "" };
    }
  };

  const releaseText = dependencies.osReleaseText ?? readText("/etc/os-release");
  const release = parseOsRelease(releaseText);
  const kernel = dependencies.kernel ?? commandValue(execute("uname", ["-r"]), "");
  const machine = dependencies.architecture ?? commandValue(execute("uname", ["-m"]), process.arch);
  const architecture = normalizeHostArchitecture(machine);
  const osId = release.ID ?? "unknown";
  const osRelease = (release.PRETTY_NAME ?? release.VERSION_ID ?? "unknown").replace(
    /^Ubuntu\s+/i,
    ""
  );
  const codename = release.VERSION_CODENAME ?? "unknown";
  const expectedRelease =
    osId === "ubuntu" && osRelease === "26.04.1 LTS" && codename === "resolute";
  // add(
  //   "ubuntu_release",
  //   expectedRelease ? "pass" : "fail",
  //   expectedRelease ? "ubuntu_release_supported" : "ubuntu_release_unsupported",
  //   "Use Ubuntu 26.04.1 LTS (resolute) for this setup profile.",
  //   osRelease
  // );
  add(
    "host_architecture",
    architecture === "x86_64" ? "pass" : "fail",
    architecture === "x86_64" ? "host_architecture_supported" : "host_architecture_unsupported",
    "Use an x86_64 Ubuntu host for this setup profile.",
    architecture
  );
  add(
    "host_kernel",
    kernel ? "pass" : "fail",
    kernel ? "host_kernel_observed" : "host_kernel_unavailable",
    "Run setup on the native Ubuntu host.",
    kernel || undefined
  );

  const nodeVersion = normalizeVersion(dependencies.nodeVersion ?? process.version);
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  add(
    "node_version",
    nodeMajor >= 24 ? "pass" : "fail",
    nodeMajor >= 24 ? "node_version_supported" : "node_version_unsupported",
    "Install Node.js 24 or later and rerun host preflight.",
    nodeVersion
  );

  const npmResult = execute("npm", ["--version"]);
  const npmVersion = npmResult.status === 0 ? sanitizeVersion(npmResult.stdout) : null;
  add(
    "npm_command",
    npmVersion ? "pass" : "fail",
    npmVersion ? "npm_available" : "npm_unavailable",
    "Install npm with the supported Node.js runtime and rerun host preflight.",
    npmVersion ?? undefined
  );
  const dockerResult = execute("docker", ["--version"]);
  const dockerClient = dockerResult.status === 0 ? sanitizeVersion(dockerResult.stdout) : null;
  add(
    "docker_cli",
    dockerClient ? "pass" : "fail",
    dockerClient ? "docker_cli_available" : "docker_cli_unavailable",
    "Install the Docker CLI and rerun host preflight.",
    dockerClient ?? undefined
  );
  const composeResult = execute("docker", ["compose", "version", "--short"]);
  const compose = composeResult.status === 0 ? sanitizeVersion(composeResult.stdout) : null;
  add(
    "compose_plugin",
    compose ? "pass" : "fail",
    compose ? "compose_plugin_available" : "compose_plugin_unavailable",
    "Install the Docker Compose plugin and rerun host preflight.",
    compose ?? undefined
  );

  const engineResult = execute("docker", [
    "info",
    "--format",
    "{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}"
  ]);
  const [rawEngineVersion, rawEngineOs, rawEngineArch] = commandValue(engineResult, "").split("|");
  const serverVersion = engineResult.status === 0 ? sanitizeVersion(rawEngineVersion ?? "") : null;
  const engineOs = engineResult.status === 0 ? String(rawEngineOs ?? "").toLowerCase() : null;
  const engineArch =
    engineResult.status === 0 ? normalizeDockerArchitecture(rawEngineArch ?? "") : null;
  const engineMatches = Boolean(
    engineResult.status === 0 && serverVersion && engineOs === "linux" && engineArch === "amd64"
  );
  add(
    "docker_engine_access",
    engineMatches ? "pass" : "fail",
    engineMatches ? "docker_engine_local_linux_ready" : "docker_engine_unavailable_or_unsupported",
    "Start an accessible Linux Docker Engine and rerun host preflight.",
    engineMatches ? "local-linux-amd64" : undefined
  );

  const envFile = resolveFromRoot(root, env.PARKBENCH_ENV_FILE || ".env.local");
  const composeFile = resolveFromRoot(
    root,
    env.PARKBENCH_COMPOSE_FILE || "deploy/platform-compose.yml"
  );
  const envFileExists = fs.existsSync(envFile) && fs.statSync(envFile).isFile();
  const composeFileExists = fs.existsSync(composeFile) && fs.statSync(composeFile).isFile();
  const composeEnvironment = createComposeEnvironment(root, env, envFile, composeFile);
  let composeConfigPass = false;
  if (compose && envFileExists && composeFileExists) {
    const configResult = execute(
      "docker",
      ["compose", "--env-file", envFile, "-f", composeFile, "config", "--quiet"],
      { env: composeEnvironment }
    );
    composeConfigPass = configResult.status === 0;
  }
  add(
    "compose_config",
    composeConfigPass ? "pass" : "fail",
    composeConfigPass ? "compose_config_valid" : "compose_config_invalid",
    "Check .env.local and deploy/platform-compose.yml, then rerun host preflight.",
    composeConfigPass ? "valid" : undefined
  );

  let npmPingPass = false;
  if (npmVersion) npmPingPass = execute("npm", ["ping", "--silent"]).status === 0;
  add(
    "npm_registry",
    npmPingPass ? "pass" : "fail",
    npmPingPass ? "npm_registry_reachable" : "npm_registry_unreachable",
    "Check the effective npm registry connectivity and configuration, then rerun host preflight."
  );

  const dataRoot = resolveFromRoot(root, env.PARKBENCH_HOST_DATA_ROOT || ".parkbench");
  const dockerDataRootValue = env.PARKBENCH_DOCKER_HOST_PATH_ROOT?.trim();
  const dockerDataRoot = dockerDataRootValue
    ? resolveFromRoot(root, dockerDataRootValue)
    : dataRoot;
  const dataRootParent = dataRoot
    ? fs.existsSync(dataRoot)
      ? dataRoot
      : path.dirname(dataRoot)
    : "";
  const dataRootReady =
    Boolean(dataRoot) &&
    isDirectory(dataRootParent) &&
    isWritable(dataRootParent) &&
    dockerDataRoot === dataRoot;
  add(
    "host_data_root",
    dataRootReady ? "pass" : "fail",
    dataRootReady ? "host_data_root_ready" : "host_data_root_unavailable_or_mismatched",
    "Set PARKBENCH_HOST_DATA_ROOT and PARKBENCH_DOCKER_HOST_PATH_ROOT to the same writable host directory."
  );

  const progressRoot = resolveFromRoot(root, env.PARKBENCH_OPENEDGE_PROGRESS_ROOT || "../IMAGES");
  const licensePath = resolveFromRoot(
    root,
    env.PARKBENCH_OPENEDGE_LICENSE_PATH || "../progress.cfg"
  );
  const workloadRoot = resolveFromRoot(
    root,
    env.PARKBENCH_OPENEDGE_WORKLOAD_ROOT || "openedge/workloads/Workloads"
  );
  addPathCheck(
    "progress_assets",
    progressRoot,
    true,
    "Set PARKBENCH_OPENEDGE_PROGRESS_ROOT to the local Progress assets directory."
  );
  addPathCheck(
    "license_input",
    licensePath,
    false,
    "Set PARKBENCH_OPENEDGE_LICENSE_PATH to the locally supplied license file."
  );
  addPathCheck(
    "workload_sources",
    workloadRoot,
    true,
    "Set PARKBENCH_OPENEDGE_WORKLOAD_ROOT to the local workload source directory."
  );

  const compilerValue = env.PARKBENCH_OPENEDGE_COMPILER?.trim() ?? "";
  const compilerPath = compilerValue ? resolveFromRoot(root, compilerValue) : "";
  const compilerReady = Boolean(compilerPath && isFile(compilerPath) && isExecutable(compilerPath));
  add(
    "compiler_adapter",
    compilerReady ? "pass" : "fail",
    compilerReady
      ? "compiler_adapter_executable"
      : compilerPath && isFile(compilerPath)
        ? "compiler_adapter_not_executable"
        : "compiler_adapter_unavailable",
    "Set PARKBENCH_OPENEDGE_COMPILER to an executable local compiler adapter."
  );
  let compilerAdapterVersion = null;
  if (compilerReady) {
    const versionResult = execute(compilerPath, ["--version"]);
    compilerAdapterVersion =
      versionResult.status === 0 ? sanitizeVersion(versionResult.stdout) : null;
  }
  add(
    "compiler_adapter_version",
    compilerAdapterVersion ? "pass" : "warning",
    compilerAdapterVersion
      ? "compiler_adapter_version_recorded"
      : "compiler_adapter_version_unavailable",
    "Provide a side-effect-free --version response to record the compiler adapter version."
  );

  const imageSettings = [
    [
      "PARKBENCH_OPENEDGE_DB_BASE_IMAGE",
      env.PARKBENCH_OPENEDGE_DB_BASE_IMAGE || env.PARKBENCH_OPENEDGE_DB_IMAGE
    ],
    [
      "PARKBENCH_OPENEDGE_PAS_BASE_IMAGE",
      env.PARKBENCH_OPENEDGE_PAS_BASE_IMAGE || env.PARKBENCH_OPENEDGE_PAS_IMAGE
    ],
    ["PARKBENCH_OPENEDGE_JDK_IMAGE", env.PARKBENCH_OPENEDGE_JDK_IMAGE]
  ];
  for (const [setting, image] of imageSettings) {
    let available = false;
    if (dockerClient && image)
      available = execute("docker", ["image", "inspect", image]).status === 0;
    const id = setting.toLowerCase();
    add(
      id,
      available ? "pass" : "fail",
      available
        ? "imported_image_available"
        : image
          ? "imported_image_unavailable"
          : "imported_image_setting_missing",
      `Set ${setting} and import that image into the Docker Engine selected by the Docker CLI before building.`
    );
  }

  let freeBytes = dependencies.freeBytes;
  if (freeBytes === undefined) {
    try {
      const stats = fs.statfsSync(dataRootParent);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      freeBytes = 0;
    }
  }
  const diskReady = Number.isFinite(freeBytes) && freeBytes >= MINIMUM_FREE_BYTES;
  add(
    "disk_space",
    diskReady ? "pass" : "fail",
    diskReady ? "disk_space_available" : "disk_space_unavailable",
    "Free at least 10 GiB on the filesystem used by PARKBENCH_HOST_DATA_ROOT.",
    diskReady ? Math.floor(freeBytes / 1024 ** 3) : undefined
  );

  const bindAddress = env.PARKBENCH_BIND_ADDRESS || "127.0.0.1";
  const portInUse = dependencies.portInUse ?? isPortInUse;
  const composeArgs = ["compose", "--env-file", envFile, "-f", composeFile];
  for (const entry of PORTS) {
    const port = Number.parseInt(env[entry.setting] || String(entry.fallback), 10);
    const validPort = Number.isInteger(port) && port > 0 && port <= 65535;
    let busy = !validPort || (await portInUse(bindAddress, port));
    if (busy && validPort && composeConfigPass) {
      const mapped = execute(
        "docker",
        [...composeArgs, "port", entry.service, String(entry.target)],
        { env: composeEnvironment }
      );
      const mappedPort =
        mapped.status === 0 ? Number.parseInt(mapped.stdout.trim().split(":").at(-1), 10) : NaN;
      if (mappedPort === port) busy = false;
    }
    add(
      entry.id,
      busy ? "fail" : "pass",
      busy ? "required_port_unavailable" : "required_port_available",
      `Free ${entry.setting} or verify that its existing listener belongs to the ParkBench service.`,
      validPort && !busy ? port : undefined
    );
  }

  const failed = checks.some((check) => check.status === "fail");
  const profile = {
    contractVersion: "host-environment.v1",
    capturedAt: now().toISOString(),
    status: failed ? "blocked" : "ready",
    host: { osId, osRelease, codename, kernel, architecture },
    toolchain: {
      node: nodeVersion,
      npm: npmVersion,
      dockerClient,
      compose,
      compilerAdapterVersion
    },
    engine: {
      reachable: engineResult.status === 0,
      contextName: null,
      serverVersion,
      operatingSystem: engineOs,
      architecture: engineArch,
      endpointKind: null
    },
    checks
  };
  return profile;

  function addPathCheck(id, target, directory, action) {
    const exists = directory ? isDirectory(target) : isFile(target);
    let readable = false;
    try {
      fs.accessSync(target, fs.constants.R_OK);
      readable = true;
    } catch {
      readable = false;
    }
    const valid = exists && readable;
    add(id, valid ? "pass" : "fail", valid ? `${id}_available` : `${id}_unavailable`, action);
  }
}

export function writeHostEnvironmentProfile(profile, root = REPO_ROOT, env = process.env) {
  const dataRoot = resolveFromRoot(root, env.PARKBENCH_HOST_DATA_ROOT || ".parkbench");
  if (!dataRoot) throw new Error("host_data_root_unavailable");
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const target = path.join(dataRoot, "host-environment.json");
  const temporary = path.join(dataRoot, `.host-environment-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

export function redactSafeError() {
  return "host_preflight_failed";
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function parseOsRelease(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    values[match[1]] = value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
  }
  return values;
}

function commandValue(result, fallback) {
  return result?.status === 0 ? String(result.stdout ?? "").trim() : fallback;
}

function normalizeVersion(value) {
  const normalized = sanitizeVersion(String(value).replace(/^v/, ""));
  return normalized ?? "0.0.0";
}

function normalizeHostArchitecture(value) {
  if (["x86_64", "amd64", "x64"].includes(value)) return "x86_64";
  if (["aarch64", "arm64"].includes(value)) return "arm64";
  return String(value).slice(0, 64) || "unknown";
}

function normalizeDockerArchitecture(value) {
  if (["x86_64", "amd64", "x64"].includes(value)) return "amd64";
  if (["aarch64", "arm64"].includes(value)) return "arm64";
  return String(value).slice(0, 64) || null;
}

function resolveFromRoot(root, value) {
  try {
    return resolveHostPath(value, { root });
  } catch {
    return "";
  }
}

export function createComposeEnvironment(root, env, envFile, composeFile) {
  const result = {
    ...env,
    PARKBENCH_ENV_FILE: envFile,
    PARKBENCH_COMPOSE_FILE: composeFile,
    PARKBENCH_REPOSITORY_ROOT: root
  };
  const resolveSetting = (setting, value) => {
    const resolved = resolveFromRoot(root, value);
    if (resolved) result[setting] = resolved;
    return resolved;
  };

  const hostDataRoot = resolveSetting(
    "PARKBENCH_HOST_DATA_ROOT",
    env.PARKBENCH_HOST_DATA_ROOT || ".parkbench"
  );
  const dockerHostRootValue =
    env.PARKBENCH_DOCKER_HOST_PATH_ROOT?.trim() || hostDataRoot || ".parkbench";
  const dockerHostRoot = resolveSetting("PARKBENCH_DOCKER_HOST_PATH_ROOT", dockerHostRootValue);
  resolveSetting(
    "PARKBENCH_PROMETHEUS_TARGET_DIR",
    env.PARKBENCH_PROMETHEUS_TARGET_DIR || ".parkbench/prometheus-targets"
  );
  resolveSetting(
    "PARKBENCH_DOCKER_SOCKET_PATH",
    env.PARKBENCH_DOCKER_SOCKET_PATH || "/var/run/docker.sock"
  );

  if (dockerHostRoot) {
    for (const setting of ["PARKBENCH_OPENEDGE_APP_ARCHIVE", "PARKBENCH_OPENEDGE_IMAGE_MANIFEST"]) {
      const value = env[setting]?.trim();
      if (!value) continue;
      try {
        result[`PARKBENCH_CONTROL_PLANE_${setting.slice("PARKBENCH_".length)}`] =
          mapHostPathToContainer(value, dockerHostRoot, "/var/lib/parkbench", { root });
      } catch {
        // Path validation reports the bounded failure through the normal preflight checks.
      }
    }
  }
  return result;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isWritable(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(target) {
  try {
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function isPortInUse(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.listen(port, host, () => server.close(() => resolve(false)));
  });
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("ParkBench host preflight\nUsage: node scripts/host-preflight.mjs");
    return;
  }
  loadEnvironment({ root: REPO_ROOT, required: true });
  collectHostEnvironment({ root: REPO_ROOT, env: process.env })
    .then((profile) => {
      writeHostEnvironmentProfile(profile, REPO_ROOT, process.env);
      console.log(JSON.stringify({ valid: profile.status === "ready", profile }, null, 2));
      if (profile.status !== "ready") process.exitCode = 1;
    })
    .catch(() => {
      console.error(JSON.stringify({ valid: false, error: redactSafeError() }));
      process.exitCode = 1;
    });
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  try {
    main();
  } catch {
    console.error(JSON.stringify({ valid: false, error: redactSafeError() }));
    process.exitCode = 1;
  }
}
