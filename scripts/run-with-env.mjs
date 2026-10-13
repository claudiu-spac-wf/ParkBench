#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  findRepositoryRoot,
  loadEnvironment,
  reportEnvironmentConflicts
} = require("./lib/load-env.cjs");
const root = findRepositoryRoot(path.dirname(fileURLToPath(import.meta.url)));
const loaded = loadEnvironment({ root });
reportEnvironmentConflicts(loaded);

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/run-with-env.mjs <command> [args...]");
  process.exit(2);
}
const result = spawnSync(command, args, {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: false
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
