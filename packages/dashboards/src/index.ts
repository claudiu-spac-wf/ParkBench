import { buildDashboard } from "./dashboard";
import { dashboardDefinitions } from "./dashboards/definitions";
import { DASHBOARD_UIDS, DASHBOARD_CATALOG, validateDashboardCatalog } from "./model";
import { tieBreakRules } from "./rules";

export * from "./model";
export { dashboardDefinitions, layoutRows } from "./dashboards/definitions";
export { UNIT_CONVENTIONS, unitFor } from "./units";
export { ranking } from "./topn";

/** Output file names under the repository root. Host and Platform keep their v1 files. */
export const DASHBOARD_FILES = Object.fromEntries(
  DASHBOARD_CATALOG.map((e) => [e.key, `deploy/grafana/dashboards/${e.folder}/${e.file}`])
) as Record<keyof typeof DASHBOARD_UIDS, string>;

export const RULES_FILE = "deploy/prometheus/rules/parkbench-dashboards.yml";

/** Files retired by this generator (FR-025). */
export const RETIRED_FILES = [
  "host-resources",
  "platform-resources",
  "db-resources",
  "run-resources",
  "run-summary",
  "benchmark-overview",
  "database-activity",
  "database-recovery-concurrency",
  "database-parameters",
  "pas-instances",
  "database-resources"
].map((file) => `deploy/grafana/dashboards/${file}.json`);

/** Every generated file and its content, keyed by repository-relative path. */
export function generatedFiles(options: { webUrl?: string } = {}): Record<string, string> {
  validateDashboardCatalog();
  const definitions = dashboardDefinitions();
  const files: Record<string, string> = {};
  for (const key of Object.keys(definitions) as Array<keyof typeof definitions>)
    files[DASHBOARD_FILES[key]] =
      `${JSON.stringify(buildDashboard(key, definitions[key], options), null, 2)}\n`;
  files[RULES_FILE] = tieBreakRules();
  return files;
}
