import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { loadContracts } from "../lib/contracts.mjs";

const require = createRequire(import.meta.url);
const { findRepositoryRoot, loadEnvironment } = require("../lib/load-env.cjs");
const repoRoot = findRepositoryRoot(path.dirname(new URL(import.meta.url).pathname));
const requiredServices = [
  "control-plane",
  "web",
  "prometheus",
  "grafana",
  "cadvisor",
  "node-exporter"
];

export async function licensedUiPreflight({
  root = repoRoot,
  env = process.env,
  envFile = ".env.local",
  runCommand = defaultRunCommand,
  fetchImpl = globalThis.fetch,
  browserExecutablePath = chromium.executablePath()
} = {}) {
  if (String(env.PARKBENCH_SMOKE_SKIP_DISK_IO ?? "").trim())
    throw new Error("licensed_disk_io_opt_out_forbidden");

  const files = {
    PARKBENCH_OPENEDGE_LICENSE_PATH: "file",
    PARKBENCH_OPENEDGE_PROGRESS_ROOT: "directory",
    PARKBENCH_OPENEDGE_APP_ARCHIVE: "file",
    PARKBENCH_OPENEDGE_IMAGE_MANIFEST: "file"
  };
  for (const [setting, kind] of Object.entries(files)) {
    const value = env[setting];
    if (typeof value !== "string" || !value.trim())
      throw new Error(`licensed_ui_setting_required:${setting}`);
    checkConfiguredPath(root, value, setting, kind);
  }
  // Runs use the default seed: a Linux OpenEdge database folder under the seeds root.
  if (!env.PARKBENCH_OPENEDGE_DEFAULT_SEED?.trim())
    throw new Error("licensed_ui_setting_required:PARKBENCH_OPENEDGE_DEFAULT_SEED");
  try {
    loadContracts().validateSeedDirectory(
      path.join(
        resolveConfiguredPath(root, env.PARKBENCH_DISCOVERY_SEEDS_ROOT || ".parkbench/seeds"),
        env.PARKBENCH_OPENEDGE_DEFAULT_SEED.trim()
      )
    );
  } catch {
    throw new Error("licensed_ui_seed_unavailable");
  }

  const imageSettings = {
    db: "PARKBENCH_OPENEDGE_DB_IMAGE",
    pas: "PARKBENCH_OPENEDGE_PAS_IMAGE",
    observer: "PARKBENCH_OPENEDGE_OBSERVER_IMAGE",
    supportObserver: "PARKBENCH_OBSERVER_IMAGE",
    loadgen: "PARKBENCH_LOADGEN_IMAGE"
  };
  const images = {};
  for (const [role, setting] of Object.entries(imageSettings)) {
    const reference = env[setting];
    if (typeof reference !== "string" || !reference.trim())
      throw new Error(`licensed_ui_setting_required:${setting}`);
    if (!isExplicitImageReference(reference))
      throw new Error(`licensed_ui_image_reference_invalid:${setting}`);
    images[role] = reference;
  }
  if (
    env.PARKBENCH_OPENEDGE_IMAGE_STAGE !== "final" ||
    env.PARKBENCH_OPENEDGE_PARKBENCH_READY !== "true"
  )
    throw new Error("licensed_ui_final_parkbench_images_required");

  const manifestPath = resolveConfiguredPath(root, env.PARKBENCH_OPENEDGE_IMAGE_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("licensed_ui_image_manifest_invalid");
  }
  if (
    manifest?.imageStage !== "final" ||
    manifest?.parkBenchReady !== true ||
    manifest?.db?.reference !== images.db ||
    manifest?.pasoe?.reference !== images.pas ||
    manifest?.observer?.reference !== images.observer
  )
    throw new Error("licensed_ui_final_image_manifest_mismatch");

  ensureBrowserExecutable(browserExecutablePath);

  await runStep(
    "licensed_openedge_preflight_failed",
    runCommand,
    "npm",
    ["run", "openedge:preflight", "--", "--image-stage", "final"],
    root,
    env
  );
  await runStep(
    "licensed_platform_preflight_failed",
    runCommand,
    "npm",
    [
      "run",
      "preflight",
      "--",
      "--config",
      envFile,
      "--scenario",
      "examples/scenarios/parkbench-bank-mix.json"
    ],
    root,
    env
  );

  const composeArgs = [
    "compose",
    "--env-file",
    envFile,
    "-f",
    "deploy/platform-compose.yml",
    "ps",
    "--format",
    "json"
  ];
  let serviceRecords;
  try {
    serviceRecords = parseComposePs(await runCommand("docker", composeArgs, { cwd: root, env }));
  } catch {
    throw new Error("licensed_platform_services_not_healthy");
  }
  const byName = new Map(
    serviceRecords.map((service) => [service.Service ?? service.service, service])
  );
  const servicesReady = requiredServices.every((name) => {
    const service = byName.get(name);
    if (!service || String(service.State ?? service.state).toLowerCase() !== "running")
      return false;
    const health = String(service.Health ?? service.health ?? "").toLowerCase();
    const status = String(service.Status ?? service.status ?? "").toLowerCase();
    return health !== "unhealthy" && !status.includes("unhealthy");
  });
  if (!servicesReady) throw new Error("licensed_platform_services_not_healthy");

  for (const reference of Object.values(images)) {
    try {
      const output = await runCommand("docker", ["image", "inspect", reference], {
        cwd: root,
        env
      });
      const inspected = JSON.parse(String(output));
      if (!Array.isArray(inspected) || !inspected[0]?.Id)
        throw new Error("image_inspection_invalid");
    } catch {
      throw new Error("licensed_ready_image_unavailable");
    }
  }

  const uiUrl = env.PARKBENCH_LICENSED_UI_URL || "http://127.0.0.1:13002/";
  try {
    const base = new URL(uiUrl);
    const uiResponse = await fetchImpl(base, { signal: AbortSignal.timeout(5_000) });
    if (!uiResponse.ok) throw new Error("ui_http_unavailable");
    const apiUrl = new URL("/api/v1/overview", base);
    const apiResponse = await fetchImpl(apiUrl, { signal: AbortSignal.timeout(5_000) });
    if (!apiResponse.ok) throw new Error("api_http_unavailable");
    const overview = await apiResponse.json();
    if (overview.health?.prometheus === "unavailable" || overview.health?.docker === "unavailable")
      throw new Error("platform_health_unavailable");
    const [assets, scenarios, options] = await Promise.all([
      getAllCatalogAssets(base, fetchImpl),
      getJson(fetchImpl, new URL("/api/v1/scenarios", base)),
      getJson(fetchImpl, new URL("/api/v1/ui-options", base))
    ]);
    // Images and credentials are operator environment settings, not catalog
    // choices. The preflights and Docker inspection above validate them.
    if (!hasReadyAsset(assets, "seed") || !hasReadyAsset(assets, "archive"))
      throw new Error("catalog_managed_inputs_unavailable");
    const scenarioItems = scenarios.scenarios ?? scenarios.items ?? [];
    if (
      !scenarioItems.some(
        (scenario) => scenario.id === "parkbench-bank-mix" && scenario.version === "1.0.0"
      )
    )
      throw new Error("licensed_parkbench_scenario_unavailable");
    if (!options.databaseParameters?.parameters && !options.credentialReferences)
      throw new Error("licensed_ui_options_unavailable");
  } catch {
    throw new Error("licensed_ui_unavailable");
  }

  return {
    valid: true,
    openEdge: "passed",
    platform: "passed",
    dockerServices: "healthy",
    readyImages: "available",
    diskIoOptOut: "unset",
    browser: "available",
    uiOrigin: new URL(uiUrl).origin
  };
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("api_http_unavailable");
  return response.json();
}

async function getAllCatalogAssets(base, fetchImpl) {
  const items = [];
  let pageToken;
  const seen = new Set();
  do {
    const url = new URL("/api/v1/catalog/assets", base);
    url.searchParams.set("pageSize", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("catalog_unavailable");
    const page = await response.json();
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw new Error("catalog_pagination_invalid");
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  return items;
}

function hasReadyAsset(assets, kind, expectedReference) {
  return assets.some((asset) => {
    if (
      asset.kind !== kind ||
      asset.verificationState !== "VERIFIED" ||
      asset.availability !== "AVAILABLE" ||
      asset.readiness !== "READY" ||
      asset.classificationState !== "CLASSIFIED"
    )
      return false;
    if (!expectedReference) return true;
    const identity = asset.immutableRef ?? asset.sourceRef ?? asset.provenance?.reference;
    if (typeof identity !== "string") return false;
    if ((kind === "seed" || kind === "archive") && !identity.trim()) return false;
    return identity.split("@", 1)[0] === String(expectedReference).split("@", 1)[0];
  });
}

function checkConfiguredPath(root, value, setting, kind) {
  const file = resolveConfiguredPath(root, value);
  let stat;
  try {
    stat = fs.statSync(file);
    fs.accessSync(file, fs.constants.R_OK);
    if (stat.isDirectory()) fs.readdirSync(file);
  } catch {
    throw new Error(`licensed_input_unavailable:${setting}`);
  }
  if (kind === "file" && !stat.isFile()) throw new Error(`licensed_input_unavailable:${setting}`);
  if (kind === "directory" && !stat.isDirectory())
    throw new Error(`licensed_input_unavailable:${setting}`);
  if (kind === "either" && !stat.isDirectory() && !stat.isFile())
    throw new Error(`licensed_input_unavailable:${setting}`);
}

function resolveConfiguredPath(root, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}

function isExplicitImageReference(value) {
  if (typeof value !== "string" || !value || /\s/.test(value)) return false;
  const named = value.split("@", 1)[0];
  const colon = named.lastIndexOf(":");
  const slash = named.lastIndexOf("/");
  if (colon <= slash) return false;
  const tag = named.slice(colon + 1);
  return Boolean(
    tag && tag.toLowerCase() !== "latest" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(named)
  );
}

function ensureBrowserExecutable(file) {
  try {
    const stat = fs.statSync(file);
    fs.accessSync(file, fs.constants.X_OK);
    if (!stat.isFile()) throw new Error("not_a_file");
  } catch {
    throw new Error("licensed_playwright_browser_unavailable");
  }
}

function parseComposePs(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return [value];
  } catch {
    const lines = text.split(/\r?\n/).filter(Boolean);
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      throw new Error("compose_json_invalid");
    }
  }
  throw new Error("compose_json_invalid");
}

async function runStep(defaultCode, runCommand, command, args, cwd, env) {
  try {
    return await runCommand(command, args, { cwd, env });
  } catch (error) {
    const message = String(error?.message ?? error);
    const safeCodes = [
      "disk_io_sources_unavailable",
      "prometheus_unavailable",
      "docker_unavailable",
      "image_not_inspectable",
      "seed_path_required",
      "workload_database_mismatch",
      "observer_image_mismatch",
      "openedge_manifest_database_image_mismatch",
      "openedge_manifest_pasoe_image_mismatch"
    ];
    const known = safeCodes.find((code) => message.includes(code));
    throw new Error(known ?? defaultCode);
  }
}

function defaultRunCommand(command, args, options) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Number(options.env.PARKBENCH_LICENSED_PREFLIGHT_TIMEOUT_MS ?? 900_000)
  });
}

function parseArgs(argv) {
  const result = { root: repoRoot, envFile: ".env.local" };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      result.help = true;
      continue;
    }
    if (!["--root", "--env-file"].includes(option)) throw new Error("licensed_ui_argument_invalid");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("licensed_ui_argument_value_required");
    result[option === "--root" ? "root" : "envFile"] = value;
    index += 1;
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(
        "Usage: node scripts/openedge/licensed-ui-preflight.mjs [--root PATH] [--env-file PATH]"
      );
      return;
    }
    const root = path.resolve(options.root);
    loadEnvironment({ root, envFile: options.envFile, required: true });
    console.log(
      JSON.stringify(
        await licensedUiPreflight({ root, env: process.env, envFile: options.envFile }),
        null,
        2
      )
    );
  } catch (error) {
    const message = String(error?.message ?? error);
    const safe = message.match(
      /^(?:licensed_[a-z0-9_]+(?::[A-Z0-9_]+)?|disk_io_sources_unavailable|prometheus_unavailable|docker_unavailable|image_not_inspectable|seed_path_required|workload_database_mismatch|observer_image_mismatch|openedge_manifest_[a-z0-9_]+)/i
    )?.[0];
    console.error(JSON.stringify({ valid: false, error: safe ?? "licensed_ui_preflight_failed" }));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) void main();
