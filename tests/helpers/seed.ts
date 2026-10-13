import fs from "node:fs";
import path from "node:path";

/** The ParkBenchDB structure file, with relative extent paths as in BenchmarkDb/one_gb_lnx. */
const PARKBENCH_ST = path.resolve("tests/fixtures/seeds/parkbench.st");

/**
 * Writes a structurally valid seed folder under `seedsRoot/<name>`: the ParkBenchDB .st and an
 * empty file per extent it implies, laid out like an on-disk Linux database.
 */
export function createSeedFixture(
  seedsRoot: string,
  name = "one_gb_lnx",
  options: { databaseName?: string; startupPf?: string } = {}
): string {
  const seedDir = path.join(seedsRoot, name);
  const db = options.databaseName ?? "parkbench";
  fs.mkdirSync(seedDir, { recursive: true });
  fs.copyFileSync(PARKBENCH_ST, path.join(seedDir, `${db}.st`));
  const files = [`${db}.db`, `${db}.b1`, `${db}.d1`];
  for (let area = 7; area <= 20; area += 1) files.push(`${db}_${area}.d1`);
  for (const file of files) fs.writeFileSync(path.join(seedDir, file), "fixture");
  if (options.startupPf !== undefined)
    fs.writeFileSync(path.join(seedDir, "startup.pf"), options.startupPf);
  return seedDir;
}
