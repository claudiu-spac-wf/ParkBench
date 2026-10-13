#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { findRepositoryRoot, loadEnvironment } = require("../lib/load-env.cjs");
const root = findRepositoryRoot(path.dirname(fileURLToPath(import.meta.url)));

// Seeds need no staging: they are database folders already on disk under the seeds root.
export function stageCatalogInputs({ dataRoot, archivePath }) {
  if (!dataRoot || !archivePath) throw new Error("catalog_inputs_setting_required");
  const absoluteRoot = path.resolve(dataRoot);
  fs.mkdirSync(absoluteRoot, { recursive: true, mode: 0o700 });
  const staged = [];
  for (const [kind, source, name] of [["archives", archivePath, "parkbench-runner.zip"]]) {
    const sourceFile = path.resolve(source);
    if (!fs.statSync(sourceFile).isFile()) throw new Error("catalog_input_file_required");
    const directory = path.join(absoluteRoot, kind);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, name);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(sourceFile, temporary, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    staged.push({ kind, path: target });
  }
  return staged;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  try {
    loadEnvironment({ root, required: true });
    stageCatalogInputs({
      dataRoot: process.env.PARKBENCH_HOST_DATA_ROOT || path.join(root, ".parkbench"),
      archivePath: process.env.PARKBENCH_OPENEDGE_APP_ARCHIVE
    });
    process.stdout.write("catalog_inputs_staged\n");
  } catch (error) {
    const safe =
      error instanceof Error && /^catalog_[a-z_]+$/.test(error.message)
        ? error.message
        : "catalog_inputs_staging_failed";
    process.stderr.write(`${safe}\n`);
    process.exitCode = 1;
  }
}
