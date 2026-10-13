#!/usr/bin/env node
// One-time, idempotent removal of the Sports2020 inputs left in the ParkBench data folder
// (feature 014, FR-020). Run history is never touched: runs/, artifacts/ and the SQLite store
// stay as they are, so earlier runs remain viewable with their recorded inputs.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const environment = require("../lib/load-env.cjs");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function resolvePath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(repoRoot, value);
}

/** An image manifest from before feature 014 (v1, or naming the Sports2020 database). */
function isStaleManifest(file) {
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    return manifest.schemaVersion === "image-build.v1" || manifest.databaseName === "sports";
  } catch {
    return false;
  }
}

export function sports2020Paths({ dataRoot, outputRoot }) {
  const candidates = [
    { path: path.join(dataRoot, "seeds/sports2020-seeds.tar.gz") },
    { path: path.join(dataRoot, "archives/sports2020-archives.zip") },
    { path: path.join(outputRoot, "stages/generic/seed") }
  ];
  for (const directory of [outputRoot, path.join(outputRoot, "stages/generic")]) {
    const manifest = path.join(directory, "manifest.json");
    if (fs.existsSync(manifest) && isStaleManifest(manifest))
      candidates.push({ path: manifest }, { path: path.join(directory, "images.env") });
  }
  return candidates;
}

export function migrateSports2020({ dataRoot, outputRoot, dryRun = false }) {
  const protectedRoots = ["runs", "artifacts"].map((name) => path.join(dataRoot, name));
  return sports2020Paths({ dataRoot, outputRoot }).map(({ path: target }) => {
    if (
      protectedRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`)) ||
      path.basename(target).startsWith("parkbench.sqlite")
    )
      return { path: target, result: "kept" };
    if (!fs.existsSync(target)) return { path: target, result: "absent" };
    if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
    return { path: target, result: dryRun ? "would_remove" : "removed" };
  });
}

function main() {
  environment.loadEnvironment({ root: repoRoot });
  const argv = process.argv.slice(2);
  const dataRoot = resolvePath(process.env.PARKBENCH_HOST_DATA_ROOT || ".parkbench");
  const outputRoot = resolvePath(
    process.env.PARKBENCH_OPENEDGE_OUTPUT_ROOT || ".parkbench/openedge"
  );
  const results = migrateSports2020({ dataRoot, outputRoot, dryRun: argv.includes("--dry-run") });
  if (argv.includes("--json")) console.log(JSON.stringify({ results }, null, 2));
  else
    for (const item of results)
      console.log(`${item.result}\t${path.relative(repoRoot, item.path)}`);
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) main();
