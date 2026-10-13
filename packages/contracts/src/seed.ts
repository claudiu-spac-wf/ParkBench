import fs from "node:fs";
import path from "node:path";

/**
 * On-disk seed databases (feature 014, contracts/openedge-seed-v1.md). A seed is a folder under
 * the seeds root that holds one Linux OpenEdge database: `<db>.db`, a `<db>.st` with relative
 * extent paths, and the extents it implies. The database name is the `.db` file's name.
 */
export const SEED_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export interface SeedDatabase {
  /** Seed folder name, e.g. one_gb_lnx. */
  name: string;
  /** OpenEdge database name taken from `<db>.db`, e.g. parkbench. */
  databaseName: string;
  /** Total size of the seed's files, which each run copies. */
  sizeBytes: number;
}

export interface StructureExtent {
  kind: "b" | "d" | "a" | "t";
  area?: string;
  areaNumber: number;
  path: string;
  file: string;
}

/** Parses a structure (.st) file into the extent files it implies. */
export function parseStructureFile(text: string, databaseName: string): StructureExtent[] {
  const counters = new Map<string, number>();
  const extents: StructureExtent[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const match =
      /^([bdat])\s+(?:"([^"]+)"(?::(\d+)(?:,\d+)?(?:;\d+)?)?\s+)?(\S+)(?:\s+[fv]\s+\d+)?$/.exec(
        line
      );
    if (!match) throw new Error(`seed_structure_invalid:${line}`);
    const kind = match[1] as StructureExtent["kind"];
    const areaNumber = match[3] ? Number(match[3]) : kind === "d" ? 6 : 0;
    const extentPath = match[4];
    const key = `${kind}:${areaNumber}`;
    const index = (counters.get(key) ?? 0) + 1;
    counters.set(key, index);
    let file: string;
    if (kind === "d")
      file =
        areaNumber === 6 ? `${databaseName}.d${index}` : `${databaseName}_${areaNumber}.d${index}`;
    else if (kind === "t") file = `${databaseName}.t${index}`;
    else file = `${databaseName}.${kind}${index}`;
    extents.push({ kind, area: match[2], areaNumber, path: extentPath, file });
  }
  return extents;
}

export function isRelativeExtentPath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

const ALLOWED_DB_FILE = (databaseName: string) =>
  new RegExp(
    `^(?:${databaseName}(?:\\.db|\\.st|\\.lg|\\.b\\d+|\\.d\\d+|\\.a\\d+|\\.t\\d+|_\\d+\\.d\\d+)|[A-Za-z0-9_.-]+\\.pf)$`
  );

/** Checks the database files in a directory against its structure file. */
export function validateDatabaseDirectory(dbDir: string, databaseName: string): StructureExtent[] {
  const required = [`${databaseName}.db`, `${databaseName}.st`];
  for (const file of required)
    if (!fs.existsSync(path.join(dbDir, file)))
      throw new Error(`seed_database_files_missing:${file}`);
  const extents = parseStructureFile(
    fs.readFileSync(path.join(dbDir, `${databaseName}.st`), "utf8"),
    databaseName
  );
  if (!extents.some((extent) => extent.kind === "b"))
    throw new Error(`seed_database_files_missing:${databaseName}.b1`);
  for (const extent of extents) {
    if (!isRelativeExtentPath(extent.path))
      throw new Error(`seed_database_invalid:absolute_extent_path:${extent.file}`);
    if (!fs.existsSync(path.join(dbDir, extent.path, extent.file)))
      throw new Error(`seed_database_files_missing:${extent.file}`);
  }
  return extents;
}

/** The database name of the single `<db>.db` file in a seed folder. */
export function seedDatabaseName(seedDir: string): string {
  const databases = fs
    .readdirSync(seedDir)
    .filter((file) => file.endsWith(".db"))
    .map((file) => file.slice(0, -3));
  if (databases.length === 0) throw new Error("seed_database_files_missing:<db>.db");
  if (databases.length > 1) throw new Error("seed_database_invalid:multiple_databases");
  if (!DATABASE_NAME_PATTERN.test(databases[0]))
    throw new Error("seed_database_invalid:database_name");
  return databases[0];
}

/**
 * Validates a seed folder. Every run copies the whole folder, so it may hold only the database's
 * own files (plus controlled parameter files): no subfolders, links, licenses, logs or spool files.
 */
export function validateSeedDirectory(seedDir: string): SeedDatabase {
  const name = path.basename(seedDir);
  if (!SEED_NAME_PATTERN.test(name)) throw new Error("seed_database_invalid:name");
  const databaseName = seedDatabaseName(seedDir);
  const allowed = ALLOWED_DB_FILE(databaseName);
  let sizeBytes = 0;
  for (const entry of fs.readdirSync(seedDir, { withFileTypes: true })) {
    const stats = fs.lstatSync(path.join(seedDir, entry.name));
    if (stats.isSymbolicLink()) throw new Error(`seed_database_invalid:symlink:${entry.name}`);
    if (stats.isDirectory()) throw new Error(`seed_database_invalid:subfolder:${entry.name}`);
    if (!stats.isFile()) throw new Error(`seed_database_invalid:special_file:${entry.name}`);
    if (!allowed.test(entry.name)) throw new Error(`seed_database_invalid:file:${entry.name}`);
    sizeBytes += stats.size;
  }
  validateDatabaseDirectory(seedDir, databaseName);
  return { name, databaseName, sizeBytes };
}
