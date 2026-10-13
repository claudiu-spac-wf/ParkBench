#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadContracts } from "../lib/contracts.mjs";
import {
  generate,
  readInventory,
  readDomains,
  writeRoot,
  repositoryRoot,
  sidecarFor,
  validateInventory
} from "./generate-write-workloads.mjs";
const require = createRequire(import.meta.url);
export function validateWriteScenario(value, inventory = readInventory()) {
  const { validateScenario } = require("tsx/cjs/api").require(
    path.join(repositoryRoot, "packages/contracts/src/validator.ts"),
    import.meta.url
  );
  const validated = validateScenario(value);
  const inputSchema = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, "packages/contracts/src/schemas/table-write-input-v1.schema.json"),
      "utf8"
    )
  );
  const Ajv = require("ajv/dist/2020").default;
  const inputValid = new Ajv({ strict: false }).compile(inputSchema);
  for (const operation of validated.workload.operations) {
    const table = inventory.tables.find((t) => t.procedure === operation.bodyTemplate?.procName);
    if (!table) throw new Error("write_scenario_unknown_table");
    const input = operation.bodyTemplate.input;
    if (!inputValid(input)) throw new Error("write_scenario_input_invalid:" + operation.id);
    for (const [key, lob] of [
      ["FieldsList", false],
      ["LobFields", true]
    ]) {
      if (key === "FieldsList" && input.Operation === "create") continue;
      for (const fieldName of input[key] ?? []) {
        const field = table.fields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
        if (!field || Boolean(field.lob) !== lob || (!lob && field.name === table.primaryField))
          throw new Error("write_scenario_field_invalid:" + table.name + "." + fieldName);
      }
    }
    if (
      input.Operation === "update" &&
      !input.FieldsList?.length &&
      !input.LobFields?.length &&
      input.Limit > 0
    )
      throw new Error("write_scenario_no_fields");
    if (typeof input.WhereClause === "string" && input.WhereClause.includes("{{band}}"))
      throw new Error("write_scenario_band_dependency");
  }
  return validated;
}

export function validateWrites({ scenario = true } = {}) {
  const inventory = readInventory();
  validateInventory(inventory);
  generate({ check: true });
  const contracts = loadContracts();
  const names = new Set(inventory.tables.map((t) => t.name));
  if (fs.readdirSync(writeRoot).filter((n) => n.endsWith(".p")).length !== 32)
    throw new Error("write_procedure_count_invalid");
  for (const table of inventory.tables) {
    const source = fs.readFileSync(path.join(writeRoot, table.name + ".p"), "utf8");
    if (
      (source.match(/DEFINE\s+INPUT\s+PARAMETER/g) ?? []).length !== 1 ||
      !source.includes("DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.")
    )
      throw new Error("write_signature_invalid:" + table.name);
    if (
      !source.includes("&SCOPED-DEFINE PB-TABLE " + table.name + "\n") ||
      source.includes("PB-SCAFFOLD TRUE")
    )
      throw new Error("write_target_or_scaffold_invalid:" + table.name);
    const contract = JSON.parse(
      fs.readFileSync(path.join(writeRoot, table.name + ".contract.json"), "utf8")
    );
    contracts.validateWorkloadContract(contract, table.procedure);
    if (JSON.stringify(contract) !== JSON.stringify(sidecarFor(table, inventory)))
      throw new Error("write_sidecar_drift:" + table.name);
  }
  const domains = readDomains();
  if (Object.values(domains.tables).some((entries) => !entries.length))
    throw new Error("write_domain_empty");
  if (scenario) {
    const filename = path.join(repositoryRoot, "examples/scenarios/parkbench-banking-writes.json");
    if (fs.existsSync(filename)) {
      const value = JSON.parse(fs.readFileSync(filename, "utf8"));
      validateWriteScenario(value, inventory);
    }
  }
  return {
    tables: 32,
    fields: inventory.tables.reduce((n, t) => n + t.fields.length, 0),
    sourceChecksOnly: true
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(validateWrites()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
