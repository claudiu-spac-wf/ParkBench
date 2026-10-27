import fs from "node:fs";
import path from "node:path";
import { validateSeedDirectory } from "../../../../packages/contracts/src/seed";
import { ReportMetadata } from "../../../../packages/contracts/src/database-analysis-report";
export function validateReportSeed(report: ReportMetadata) {
  const s = report.seedSnapshot;
  try {
    const root = fs.realpathSync(s.managedRoot),
      real = fs.realpathSync(s.path);
    if (real !== s.path || !real.startsWith(root + path.sep)) throw new Error("path");
    const seed = validateSeedDirectory(real);
    if (seed.databaseName !== s.databaseName) throw new Error("identity");
    return seed;
  } catch {
    throw new Error("report_seed_invalid");
  }
}
export { extentAliases } from "../../../../packages/compose-runner/src/report-extent-paths";
