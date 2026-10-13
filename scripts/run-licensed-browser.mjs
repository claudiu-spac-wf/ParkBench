#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { licensedUiPreflight } from "./openedge/licensed-ui-preflight.mjs";

const require = createRequire(import.meta.url);
const { findRepositoryRoot, loadEnvironment } = require("./lib/load-env.cjs");
const { resolveHostPath } = require("./lib/resolve-paths.cjs");
const root = findRepositoryRoot(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  try {
    const envFile = process.env.PARKBENCH_ENV_FILE || ".env.local";
    loadEnvironment({ root, envFile, required: true });
    const outputRoot = resolveHostPath(
      process.env.PARKBENCH_OPENEDGE_OUTPUT_ROOT || ".parkbench/openedge",
      { root }
    );
    const generatedEnvironment = resolveHostPath(path.join(outputRoot, "images.env"), {
      root,
      requireExisting: true
    });
    loadEnvironment({ root, envFile: generatedEnvironment, required: true, preferFile: true });

    console.log(
      JSON.stringify(await licensedUiPreflight({ root, env: process.env, envFile }), null, 2)
    );
  } catch (error) {
    const message = String(error?.message ?? error);
    const safe = message.match(
      /^(?:licensed_[a-z0-9_]+(?::[A-Z0-9_]+)?|disk_io_sources_unavailable|prometheus_unavailable|docker_unavailable|image_not_inspectable|seed_path_required|workload_database_mismatch|observer_image_mismatch|openedge_manifest_[a-z0-9_]+)/i
    )?.[0];
    console.error(JSON.stringify({ valid: false, error: safe ?? "licensed_ui_preflight_failed" }));
    process.exitCode = 1;
    return;
  }

  const playwrightCli = require.resolve("@playwright/test/cli");
  const result = spawnSync(
    process.execPath,
    [playwrightCli, "test", "--config=playwright.licensed.config.ts", ...process.argv.slice(2)],
    { cwd: root, env: process.env, stdio: "inherit", shell: false }
  );
  if (result.error) {
    console.error("licensed_browser_runner_failed");
    process.exitCode = 1;
  } else process.exitCode = result.status ?? 1;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) void main();
