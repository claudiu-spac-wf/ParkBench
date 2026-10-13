import fs from "node:fs";
import path from "node:path";
export function loadScenarioSchema(version: "scenario.v1" | "scenario.v2" = "scenario.v1"): Record<string, unknown> {
  const filename = `${version.replace(".", "-")}.schema.json`;
  const candidates = [
    path.join(__dirname, "schemas", filename),
    path.join(process.cwd(), "packages/contracts/src/schemas", filename),
    path.join(process.cwd(), "packages/contracts/dist/schemas", filename)
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`${filename} is not installed`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadContractSchema(name: string): Record<string, unknown> {
  const candidates = [
    path.join(__dirname, "schemas", `${name}.schema.json`),
    path.join(process.cwd(), "packages/contracts/src/schemas", `${name}.schema.json`),
    path.join(process.cwd(), "packages/contracts/dist/schemas", `${name}.schema.json`)
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`${name}.schema.json is not installed`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
