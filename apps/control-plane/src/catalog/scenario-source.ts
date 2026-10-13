import fs from "node:fs";
import path from "node:path";
import { DiskCatalogItem } from "../../../../packages/contracts/src/catalog";
import { Scenario } from "../../../../packages/contracts/src/scenario";
import { validateScenario } from "../../../../packages/contracts/src/validator";

export interface ScenarioSourceEntry extends DiskCatalogItem {
  category: "scenarios";
  kind: "scenario";
}

export function scenarioSourceId(relativePath: string): string {
  return `discovery_file_${Buffer.from(`scenarios:scenario:${relativePath}`).toString("base64url")}`;
}

export class ScenarioFileSource {
  constructor(private readonly configuredRoot: string | undefined) {}

  list(): ScenarioSourceEntry[] {
    if (!this.configuredRoot || !fs.existsSync(this.configuredRoot)) return [];
    let root: string;
    try {
      root = fs.realpathSync(path.resolve(this.configuredRoot));
    } catch {
      return [];
    }
    const entries: ScenarioSourceEntry[] = [];
    const visit = (directory: string): void => {
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of children) {
        if (item.isSymbolicLink()) continue;
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) {
          visit(filename);
          continue;
        }
        if (!item.isFile() || !item.name.endsWith(".json")) continue;
        const relativePath = path.relative(root, filename).split(path.sep).join("/");
        const entry: ScenarioSourceEntry = {
          id: scenarioSourceId(relativePath),
          category: "scenarios",
          kind: "scenario",
          relativePath,
          displayName: item.name,
          sourceStatus: "AVAILABLE",
          failureReasons: []
        };
        try {
          const scenario = validateScenario(JSON.parse(fs.readFileSync(filename, "utf8")));
          entry.declaredScenarioId = scenario.id;
          entry.declaredScenarioVersion = scenario.version;
        } catch (error) {
          const readFailure = typeof (error as NodeJS.ErrnoException).code === "string";
          entry.sourceStatus = readFailure ? "UNAVAILABLE" : "INVALID";
          entry.failureReasons.push(
            `${readFailure ? "scenario_unreadable" : "scenario_invalid"}:${error instanceof Error ? error.message : String(error)}`
          );
        }
        entries.push(entry);
      }
    };
    visit(root);
    const pathsByDeclaredId = new Map<string, string[]>();
    for (const entry of entries) {
      if (!entry.declaredScenarioId) continue;
      const paths = pathsByDeclaredId.get(entry.declaredScenarioId) ?? [];
      paths.push(entry.relativePath);
      pathsByDeclaredId.set(entry.declaredScenarioId, paths);
    }
    for (const entry of entries) {
      const paths = pathsByDeclaredId.get(entry.declaredScenarioId ?? "") ?? [];
      if (paths.length > 1) entry.failureReasons.push(`scenario_id_conflict:${paths.join(",")}`);
    }
    return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  get(id: string): { entry: ScenarioSourceEntry; scenario: Scenario; sourcePath: string } {
    const entry = this.list().find((candidate) => candidate.id === id);
    if (!entry) throw new Error("scenario_source_missing");
    if (entry.sourceStatus !== "AVAILABLE")
      throw new Error(`scenario_source_invalid:${entry.relativePath}`);
    if (!this.configuredRoot) throw new Error("scenario_source_missing");
    const root = fs.realpathSync(path.resolve(this.configuredRoot));
    const candidate = path.resolve(root, entry.relativePath);
    if (!isWithin(candidate, root)) throw new Error("scenario_source_missing");
    const sourcePath = fs.realpathSync(candidate);
    if (!isWithin(sourcePath, root) || !fs.statSync(sourcePath).isFile())
      throw new Error("scenario_source_missing");
    return {
      entry,
      scenario: validateScenario(JSON.parse(fs.readFileSync(sourcePath, "utf8"))),
      sourcePath
    };
  }

  getByDeclaredId(
    id: string,
    version?: string
  ): { entry: ScenarioSourceEntry; scenario: Scenario; sourcePath: string } {
    const matches = this.list().filter(
      (entry) =>
        entry.declaredScenarioId === id && (!version || entry.declaredScenarioVersion === version)
    );
    if (matches.length > 1)
      throw new Error(
        `scenario_source_ambiguous:${matches.map((item) => item.relativePath).join(",")}`
      );
    if (!matches.length) throw new Error("scenario_source_missing");
    return this.get(matches[0].id);
  }
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
