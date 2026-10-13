import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const writeRoot = path.resolve("openedge/workloads/Workloads/Write");
export const inventory = JSON.parse(
  fs.readFileSync("scripts/openedge/table-write-inventory.json", "utf8")
);
export const domains = JSON.parse(
  fs.readFileSync("scripts/openedge/table-write-domains.json", "utf8")
);
export async function writeModule(name: string): Promise<any> {
  const load = Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<any>;
  return load(pathToFileURL(path.resolve("scripts/openedge", name + ".mjs")).href);
}
export function contractFor(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(writeRoot, name + ".contract.json"), "utf8"));
}
