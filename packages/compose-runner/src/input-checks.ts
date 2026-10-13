import { resolveDatabaseStartup } from "../../contracts/src/matrix-expansion";
import { DatabaseStartupParameters } from "../../contracts/src/database-startup";
import { databaseParameterInput } from "../../contracts/src/database-parameter-options";
import fs from "node:fs";
import path from "node:path";
import { ImageReferenceError, parseImageReference } from "../../contracts/src/image-reference";
import { parseStartupFile, ParsedStartupFile } from "./startup-file";
import { SeedDatabase, validateSeedDirectory } from "../../contracts/src/seed";
export function checkReadableFile(file: string, kind: string): { kind: string; location: string } {
  if (!fs.existsSync(file)) throw new Error(`${kind}_missing:${file}`);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${kind}_not_a_file:${file}`);
  return {
    kind,
    location: file
  };
}

/** Validates a seed folder (an on-disk Linux OpenEdge database) and describes it. */
export function checkReadableSeedDirectory(directory: string): SeedDatabase {
  if (!fs.existsSync(directory)) throw new Error(`seed_not_found:${path.basename(directory)}`);
  if (!fs.statSync(directory).isDirectory()) throw new Error("seed_path_required");
  return validateSeedDirectory(directory);
}

export interface StartupFileInspection {
  startupFile: { status: "absent" } | { status: "present"; relativePath: "startup.pf" };
  parsed: ParsedStartupFile;
  expandedParameterFiles: string[];
}

/**
 * Every run copies the seed into its own volume, so the run root needs room for one more
 * copy (with 20% headroom) before anything is provisioned.
 */
export function checkRunRootSpace(
  seed: Pick<SeedDatabase, "sizeBytes">,
  directory: string,
  freeBytes: (target: string) => number = (target) => {
    const stats = fs.statfsSync(target);
    return stats.bavail * stats.bsize;
  }
): void {
  let probe = path.resolve(directory);
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  if (freeBytes(probe) < seed.sizeBytes * 1.2) throw new Error("insufficient_disk_space:run_root");
}

/** Reads the optional startup.pf of a seed folder (feature 011 precedence). */
export function inspectSeedStartupFile(
  directory: string,
  additionalFiles: string[] = []
): StartupFileInspection {
  const root = fs.realpathSync(directory);
  const initial = path.join(root, "startup.pf");
  const entries: ParsedStartupFile["entries"] = [];
  const active = new Set<string>();
  const expandedParameterFiles = new Set<string>();
  let files = 0,
    bytes = 0;
  const read = (reference: string, parent = root): void => {
    const prefix = "/run/parkbench/seed/db/";
    const location = path.resolve(
      parent,
      reference.startsWith(prefix)
        ? reference.slice(prefix.length)
        : reference.replace(/^\/psc\/wrk\/[^/]+\//, "")
    );
    if (location !== root && !location.startsWith(root + path.sep))
      throw new Error("database_startup_file_invalid:pf_outside_owned_root");
    if (!fs.existsSync(location)) throw new Error("database_startup_file_invalid:pf_missing");
    const file = fs.realpathSync(location);
    if (!file.startsWith(root + path.sep) || !fs.lstatSync(location).isFile())
      throw new Error("database_startup_file_invalid:pf_type_or_symlink");
    if (active.has(file) || active.size >= 8 || ++files > 32)
      throw new Error("database_startup_file_invalid:pf_recursion");
    const stat = fs.statSync(file);
    bytes += stat.size;
    if (stat.size > 65536 || bytes > 256 * 1024)
      throw new Error("database_startup_file_invalid:pf_size");
    active.add(file);
    const parsed = parseStartupFile(fs.readFileSync(file, "utf8"));
    for (const e of parsed.entries) {
      if (e.name === "-pf") read(e.value, path.dirname(file));
      else entries.push({ ...e, sourceFile: path.relative(root, file) });
    }
    active.delete(file);
    expandedParameterFiles.add(reference);
  };
  const present = fs.existsSync(initial);
  if (present) read(initial);
  for (const f of additionalFiles) read(f);
  const winners = new Map<string, ParsedStartupFile["entries"][number]>();
  for (const e of entries) winners.set(e.name, e);
  return {
    startupFile: present ? { status: "present", relativePath: "startup.pf" } : { status: "absent" },
    expandedParameterFiles: [...expandedParameterFiles],
    parsed: {
      status: present || additionalFiles.length ? "valid" : "absent",
      entries,
      parameters: [...winners.values()]
    }
  };
}

export function checkImageReference(image: string): void {
  try {
    parseImageReference(image);
  } catch (error) {
    const code = error instanceof ImageReferenceError ? error.code : "image_reference_invalid";
    throw new Error(`image_reference_invalid:${code}`);
  }
}

export interface InputProvenance {
  reference: string;
  kind: string;
  location?: string;
}

/**
 * Checks a local input path. It must sit under one of the allowed roots: the input root, and for
 * seeds also the seeds root, which may be outside it (for example BenchmarkDb next to the repo).
 */
export function checkInputReference(
  reference: string,
  kind: string,
  allowedRoots: string | Array<string | undefined> = process.cwd()
): InputProvenance {
  if (!reference || typeof reference !== "string") throw new Error(`${kind}_reference_required`);
  if (reference.startsWith("input:")) {
    return { reference, kind };
  }
  // Seeds are database folders; other inputs are files.
  const checked =
    kind === "seed" && fs.existsSync(reference) && fs.statSync(reference).isDirectory()
      ? { kind, location: reference }
      : checkReadableFile(reference, kind);
  const resolvedInput = path.resolve(checked.location);
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots]).filter(
    (root): root is string => Boolean(root)
  );
  if (
    !roots.some((root) => {
      const resolvedRoot = path.resolve(root);
      return (
        resolvedInput === resolvedRoot || resolvedInput.startsWith(`${resolvedRoot}${path.sep}`)
      );
    })
  )
    throw new Error(`${kind}_outside_allowed_root`);
  return { reference, kind, location: checked.location };
}

export function checkCredentialReference(reference: string | undefined): void {
  if (reference !== undefined && (!reference.startsWith("credential:") || reference.length <= 11))
    throw new Error("credential_reference_required");
}

/** Fresh scheduling verifies sources even when a caller supplies a flattened manifest.
 * Replay uses the frozen manifest directly and never calls this function. */
export function resolveFreshStartupFiles(
  seed: string,
  defaults: Record<string, string | number | boolean>,
  parameters: Record<string, string | number | boolean>,
  supplied?: DatabaseStartupParameters,
  databaseName = supplied?.databaseName ?? "parkbench"
): DatabaseStartupParameters | undefined {
  const pf =
    parameters["-pf"] ??
    supplied?.parameters.find((p) => p.name === "-pf")?.displayValue ??
    defaults["-pf"];
  const physical =
    !seed.startsWith("input:") && fs.existsSync(seed) && fs.statSync(seed).isDirectory();
  if (!physical) {
    if (pf !== undefined) throw new Error("database_startup_file_required:controlled_pf_expansion");
    return supplied;
  }
  const inspection = inspectSeedStartupFile(seed, pf === undefined ? [] : [String(pf)]);
  for (const p of supplied?.parameters ?? []) {
    if (p.source !== "startup_file") continue;
    const current = inspection.parsed.parameters.find((e) => e.name === p.name);
    if (
      !current ||
      databaseParameterInput(p.name, current.value) !==
        databaseParameterInput(p.name, p.displayValue)
    )
      throw new Error(`database_startup_file_invalid:changed_since_preview:${p.name}`);
  }
  const suppliedValues = Object.fromEntries(
    (supplied?.parameters ?? []).map((p) => [
      p.name,
      databaseParameterInput(p.name, p.displayValue)
    ])
  );
  for (const [name, value] of Object.entries(parameters))
    if (Object.hasOwn(suppliedValues, name) && suppliedValues[name] !== value)
      throw new Error(`database_startup_conflict:${name}`);
  const resolved = resolveDatabaseStartup(
    { ...inspection, entries: inspection.parsed.entries, databaseName },
    defaults,
    { ...suppliedValues, ...parameters }
  );
  if (supplied)
    resolved.parameters = resolved.parameters.map(
      (p) =>
        supplied.parameters.find(
          (old) => old.name === p.name && old.displayValue === p.displayValue
        ) ?? p
    );
  return resolved;
}
