import fs from "node:fs";
import path from "node:path";
import { ScenarioCatalog } from "./catalog";

const bundledScenarios = [
  "crud-rest.json",
  "parkbench-bank-mix.json",
  "parkbench-read-mix.json",
  "parkbench-read-stable.json",
  "parkbench-banking-writes.json",
  "parkbench-read-write-90-10.json",
  "parkbench-read-write-80-20.json",
  "parkbench-read-write-70-30.json"
];

export function registerBundledScenarios(
  catalog: ScenarioCatalog,
  repositoryRoot = process.cwd()
): void {
  for (const fileName of bundledScenarios) {
    const filePath = path.join(repositoryRoot, "examples/scenarios", fileName);
    if (!fs.existsSync(filePath)) continue;
    const scenario = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!catalog.get(scenario.id, scenario.version)) catalog.register(scenario);
  }
}
