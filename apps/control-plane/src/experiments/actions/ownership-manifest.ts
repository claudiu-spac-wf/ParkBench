import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Repositories } from "../../db/repositories";
const exec = promisify(execFile);
export interface OwnedPath {
  root: string;
  relative: string;
  cleanupRelative?: string;
}
export interface OwnershipManifest {
  runIds: string[];
  experimentId: string;
  paths: OwnedPath[];
}
export function safeOwnedPath(entry: OwnedPath): string {
  const root = path.resolve(entry.root),
    target = path.resolve(root, entry.relative);
  if (target === root || !target.startsWith(root + path.sep))
    throw new Error("experiment_cleanup_path_unsafe");
  // Validate existing components; recursive removal must not escape through a symlinked ancestor.
  let current = root;
  try {
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error("experiment_cleanup_path_unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("experiment_cleanup_path_unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}
export function captureOwnership(
  repositories: Repositories,
  experimentId: string,
  artifactRoot: string,
  runRoot: string,
  cleanupId = randomUUID(),
  onlyRunId?: string
): OwnershipManifest {
  const runs = repositories.listRuns(experimentId).filter((r) => !onlyRunId || r.id === onlyRunId),
    paths: OwnedPath[] = [];
  for (const run of runs) {
    paths.push({ root: artifactRoot, relative: run.id });
    for (const suffix of [
      ".yml",
      "-scenario.json",
      "-broker.argv",
      "-broker-directories",
      "-database-evidence"
    ])
      paths.push({ root: runRoot, relative: run.composeProject + suffix });
    for (const artifact of repositories.listArtifacts(run.id)) {
      const other = repositories.client.db
        .prepare("SELECT 1 FROM artifacts WHERE path=? AND run_id<>?")
        .get(artifact.path, run.id);
      if (other) throw new Error("experiment_ownership_mismatch");
      paths.push({ root: artifactRoot, relative: artifact.path });
    }
    for (const resource of repositories.listResources(run.id)) {
      const labels = resource.labels as Record<string, string>;
      if (
        labels?.["parkbench.run_id"] !== run.id ||
        labels?.["parkbench.experiment_id"] !== experimentId
      )
        throw new Error("experiment_ownership_mismatch");
    }
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(cleanupId)) throw Error("experiment_cleanup_path_unsafe");
  paths.forEach((entry, index) => {
    safeOwnedPath(entry);
    entry.cleanupRelative = `.experiment-cleanup/${cleanupId}/${index}`;
    safeOwnedPath({ root: entry.root, relative: entry.cleanupRelative });
  });
  return { experimentId, runIds: runs.map((r) => r.id), paths };
}
export async function removeOwnedFiles(manifest: OwnershipManifest): Promise<void> {
  for (const entry of manifest.paths) {
    const file = safeOwnedPath(entry);
    let target = file;
    if (entry.cleanupRelative) {
      target = safeOwnedPath({ root: entry.root, relative: entry.cleanupRelative });
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      if (fs.existsSync(file)) {
        if (fs.existsSync(target)) throw Error("experiment_cleanup_path_unsafe");
        await fs.promises.rename(file, target);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fs.promises.rm(target, { recursive: true, force: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("experiment_file_cleanup_timeout")), 30000);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (fs.existsSync(file) || fs.existsSync(target)) throw new Error("experiment_files_remain");
  }
  for (const entry of manifest.paths)
    if (entry.cleanupRelative) {
      const parent = path.dirname(
        safeOwnedPath({ root: entry.root, relative: entry.cleanupRelative })
      );
      try {
        await fs.promises.rmdir(parent);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
    }
}
async function docker(args: string[]): Promise<string> {
  return (await exec("docker", args, { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
/** Cleanup is label-scoped, includes owned orphans, and verifies absence without relying on an old Compose file. */
export async function removeOwnedResources(manifest: OwnershipManifest): Promise<void> {
  for (const runId of manifest.runIds) {
    for (const kind of ["container", "volume", "network"] as const) {
      const list = kind === "container" ? ["ps", "-aq"] : [kind, "ls", "-q"];
      const selectors = [
        "--filter",
        `label=parkbench.run_id=${runId}`,
        "--filter",
        `label=parkbench.managed=true`
      ];
      const ids = (await docker([...list, ...selectors])).split("\n").filter(Boolean);
      for (const id of ids) {
        const [resource] = JSON.parse(
          await docker([...(kind === "container" ? [] : [kind]), "inspect", id])
        );
        const labels = resource.Config?.Labels ?? resource.Labels;
        if (
          labels?.["parkbench.run_id"] !== runId ||
          labels?.["parkbench.experiment_id"] !== manifest.experimentId ||
          labels?.["parkbench.managed"] !== "true"
        )
          throw new Error("experiment_ownership_mismatch");
        await docker(kind === "container" ? ["rm", "-f", id] : [kind, "rm", id]);
      }
      if ((await docker([...list, ...selectors])).trim())
        throw new Error("experiment_owned_resources_remain");
    }
  }
}
