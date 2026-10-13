#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const inventoryPath = path.join(
  repositoryRoot,
  "scripts/openedge/table-write-inventory.json"
);
export const domainsPath = path.join(repositoryRoot, "scripts/openedge/table-write-domains.json");
export const writeRoot = path.join(repositoryRoot, "openedge/workloads/Workloads/Write");
export function readInventory() {
  return JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
}
export function readDomains() {
  return JSON.parse(fs.readFileSync(domainsPath, "utf8"));
}
const quote = (value) =>
  `"${String(value ?? "")
    .replaceAll("~", "~~")
    .replaceAll('"', '~"')
    .replaceAll("\n", "~n")}"`;

export function validatePolicy(table, field) {
  const fail = (reason) => {
    throw new Error(`write_policy_${reason}:${table.name}.${field.name}`);
  };
  const policy = field.writePolicy;
  if (!policy?.kind) fail("missing");
  const recognized = [
    "sequence",
    "random",
    "literal",
    "date",
    "datetime",
    "datetime-tz",
    "domain",
    "parent",
    "parent-unique",
    "absent-parent",
    "unique-text",
    "unique-date",
    "wide-text",
    "lob",
    "companion",
    "audit-reference"
  ];
  if (!recognized.includes(policy.kind)) fail("unknown");
  if (field.name === table.primaryField && policy.kind !== "sequence") fail("primary");
  if ((policy.kind === "sequence") !== (field.name === table.primaryField)) fail("sequence");
  if ((field.lob && policy.kind !== "lob") || (!field.lob && policy.kind === "lob")) fail("lob");
  if (field.relationship) {
    if (!["parent", "parent-unique", "absent-parent"].includes(policy.kind)) fail("relationship");
    if (
      policy.kind === "absent-parent" &&
      (!field.relationship.optional || policy.value !== field.relationship.absentValue)
    )
      fail("absent_parent");
  } else if (["parent", "parent-unique", "absent-parent"].includes(policy.kind))
    fail("relationship");
  if (
    policy.kind === "random" &&
    (field.type !== "integer" ||
      !/^RandomInt(?:10|100|1000)$/.test(field.name) ||
      policy.value !== Number(field.name.slice(9)))
  )
    fail("random");
  if (["unique-text", "wide-text"].includes(policy.kind)) {
    if (
      field.type !== "character" ||
      typeof policy.value !== "string" ||
      !policy.value ||
      policy.value.length >= field.documentedCharacterWidth
    )
      fail("text");
  }
  if (
    ["date", "unique-date", "datetime", "datetime-tz"].includes(policy.kind) &&
    field.type !== policy.kind.replace("unique-", "")
  )
    fail("date_type");
  if (policy.kind === "literal") {
    const value = policy.value;
    if (value === undefined || value === null || value === "?") fail("literal");
    if (
      field.type === "character" &&
      (typeof value !== "string" ||
        Buffer.byteLength(value) > field.documentedCharacterWidth ||
        value.includes("|"))
    )
      fail("width");
    if (["integer", "int64"].includes(field.type) && !Number.isSafeInteger(value)) fail("integer");
    if (
      field.type === "decimal" &&
      (!Number.isFinite(value) || Number(value.toFixed(field.decimals)) !== value)
    )
      fail("decimal");
    if (field.type === "logical" && typeof value !== "boolean") fail("logical");
    if (!["character", "integer", "int64", "decimal", "logical"].includes(field.type))
      fail("literal_type");
  }
  if (policy.kind === "domain" && (!policy.value || typeof policy.value !== "string"))
    fail("domain");
  if (policy.kind === "companion" && !["FileSizeBytes", "Checksum"].includes(field.name))
    fail("companion");
}

export function validateInventory(inventory, { scaffold = false } = {}) {
  if (inventory.tables.length !== 32) throw new Error("write_inventory_table_count");
  if (
    inventory.tables.reduce((n, t) => n + t.fields.length, 0) !== 479 ||
    inventory.tables.reduce((n, t) => n + t.indexes.length, 0) !== 198
  )
    throw new Error("write_inventory_coverage");
  const seen = new Set();
  for (const table of inventory.tables) {
    if (seen.has(table.name) || !/^[A-Za-z][A-Za-z0-9]*$/.test(table.name))
      throw new Error("write_inventory_table_name");
    seen.add(table.name);
    if (table.procedure !== `Workloads/Write/${table.name}.p`)
      throw new Error("write_inventory_procedure");
    if (table.primaryField !== `${table.name}Id` || table.sequence !== `Seq${table.name}Id`)
      throw new Error("write_inventory_primary");
    for (const field of table.fields) {
      if (
        ![
          "character",
          "integer",
          "int64",
          "decimal",
          "logical",
          "date",
          "datetime",
          "datetime-tz",
          "blob",
          "clob"
        ].includes(field.type)
      )
        throw new Error(`write_inventory_type:${table.name}.${field.name}`);
      if (
        field.relationship &&
        !inventory.tables.some(
          (t) =>
            t.name === field.relationship.parentTable &&
            t.fields.some((f) => f.name === field.relationship.parentField)
        )
      )
        throw new Error(`write_inventory_parent:${table.name}.${field.name}`);
      if (
        field.lob &&
        !(
          field.lob.minimumBytes > 0 &&
          field.lob.minimumBytes <= field.lob.defaultBytes &&
          field.lob.defaultBytes <= field.lob.maximumBytes
        )
      )
        throw new Error(`write_inventory_lob:${table.name}.${field.name}`);
      if (!scaffold) validatePolicy(table, field);
    }
    if (
      new Set(table.fields.map((f) => f.name.toLowerCase())).size !== table.fields.length ||
      !table.fields.some((f) => f.name === table.primaryField)
    )
      throw new Error("write_inventory_fields");
    for (const index of table.indexes) {
      if (
        !index.components?.length ||
        index.components.some((c) => !table.fields.some((f) => f.name === (c.field ?? c.name)))
      )
        throw new Error(`write_inventory_index:${table.name}.${index.name}`);
      if (!scaffold && index.unique) {
        const policy = table.uniquePolicies?.[index.name];
        if (
          !policy ||
          !["primary", "domain", "injective", "candidate-tuple"].includes(policy.kind) ||
          JSON.stringify(policy.fields) !==
            JSON.stringify(index.components.map((c) => c.field ?? c.name))
        )
          throw new Error(`write_unique_policy_missing:${table.name}.${index.name}`);
        if (index.primary && policy.kind !== "primary")
          throw new Error(`write_unique_policy_primary:${table.name}.${index.name}`);
      }
    }
  }
}

export function validateDomains(inventory, domains) {
  const names = ["Currency", "Country", "AccountType", "TransactionType", "MerchantCategory"];
  if (JSON.stringify(Object.keys(domains.tables).sort()) !== JSON.stringify(names.sort()))
    throw new Error("write_domain_tables_invalid");
  for (const [name, rows] of Object.entries(domains.tables)) {
    const table = inventory.tables.find((t) => t.name === name);
    if (!rows.length) throw new Error("write_domain_empty:" + name);
    for (const row of rows)
      for (const [key, value] of Object.entries(row)) {
        if (name === "MerchantCategory" && ["minimumCode", "maximumCode"].includes(key)) {
          if (
            !Number.isInteger(value) ||
            value < 1000 ||
            value > 9999 ||
            row.minimumCode > row.maximumCode
          )
            throw new Error("write_domain_range_invalid");
          continue;
        }
        const field = table.fields.find((f) => f.name === key);
        if (!field) throw new Error("write_domain_field_invalid:" + name + "." + key);
        validatePolicy(table, {
          ...field,
          relationship: undefined,
          writePolicy: { kind: "literal", value }
        });
      }
  }
  for (const table of inventory.tables)
    for (const field of table.fields)
      if (field.writePolicy?.kind === "domain") {
        if (
          field.writePolicy.value !== table.name ||
          !domains.tables[table.name] ||
          (table.name !== "MerchantCategory" &&
            domains.tables[table.name].some((row) => !Object.hasOwn(row, field.name)))
        )
          throw new Error("write_policy_domain_invalid:" + table.name + "." + field.name);
      }
  const currencies = new Set(domains.tables.Currency.map((row) => row.CurrencyCode));
  if (domains.tables.Country.some((row) => !currencies.has(row.DefaultCurrencyCode)))
    throw new Error("write_domain_currency_invalid");
}

export function sidecarFor(table, inventory) {
  const parents = [
    ...new Set(table.fields.filter((f) => f.relationship).map((f) => f.relationship.parentTable))
  ].sort();
  const requiredFields = table.fields.map((f) => `${table.name}.${f.name}:${f.type}`);
  const requiredIndexes = table.indexes.map((i) => `${table.name}.${i.name}`);
  for (const field of table.fields.filter((f) => f.relationship)) {
    const rel = field.relationship;
    const parent = inventory.tables.find((t) => t.name === rel.parentTable);
    const descriptor = parent.fields.find((f) => f.name === rel.parentField);
    requiredFields.push(`${parent.name}.${descriptor.name}:${descriptor.type}`);
    for (const index of parent.indexes.filter(
      (i) => i.unique && (i.components[0].field ?? i.components[0].name) === rel.parentField
    ))
      requiredIndexes.push(`${parent.name}.${index.name}`);
  }
  for (const dependency of table.readDependencies ?? []) {
    const parent = inventory.tables.find((t) => t.name === dependency.table);
    const descriptor = parent?.fields.find((f) => f.name === dependency.field);
    if (!descriptor) throw new Error("write_inventory_dependency_invalid");
    if (!parents.includes(parent.name)) parents.push(parent.name);
    requiredFields.push(`${parent.name}.${descriptor.name}:${descriptor.type}`);
    for (const index of parent.indexes.filter(
      (i) => i.unique && i.components[0].field === descriptor.name
    ))
      requiredIndexes.push(`${parent.name}.${index.name}`);
  }
  return {
    contractVersion: "workload-contract.v1",
    id: table.workloadId,
    version: 1,
    procedure: table.procedure,
    databaseName: "parkbench",
    requiredTables: [table.name, ...parents].map((name) => ({ name, minimumRows: 0 })),
    requiredFields: [...new Set(requiredFields)],
    requiredIndexes: [...new Set(requiredIndexes)],
    requiredSequences: [table.sequence],
    input: {
      Operation: ["create", "update"],
      Limit: { minimum: 0, maximum: 10000 },
      WhereClause: "native target-table condition for updates",
      FieldsList: "ordinary-field-name array for updates",
      LobFields: "LOB-field-name array for either operation"
    },
    operations: ["create", "update"].map((op) => ({
      op,
      tables: [table.name],
      access: op,
      bounds: { min: 0, max: 10000 }
    })),
    writes: {
      tables: [table.name],
      scope: "target records created or selected by this invocation",
      cleanup: "none; persists until normal run-copy cleanup"
    },
    readiness: { mode: "validate", readOnly: true, failurePrefix: "database_schema_invalid:" },
    seedOwnership: { sourceIsImmutable: true, writableState: "fresh run-owned database volume" }
  };
}

export function renderWrapper(table, scaffold) {
  return `/* Generated fixed-table write workload. ${scaffold ? "PROVISIONAL SCAFFOLD: operational writes disabled." : "Validated policy inventory; do not edit generated source."} */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.JsonDataType.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.
&SCOPED-DEFINE PB-TABLE ${table.name}
&SCOPED-DEFINE PB-SCAFFOLD ${scaffold ? "TRUE" : "FALSE"}
{write-common.i}
{write-generators.i}
{write-inventory.i}
CREATE WIDGET-POOL.
DO ON ERROR UNDO, THROW:
  pbIgnored = pbLoadInventory().
  pbIgnored = pbParse().
  IF pbMode = "validate" THEN DO:
    pbIgnored = pbReadiness().
    RETURN.
  END.
  IF {&PB-SCAFFOLD} THEN UNDO, THROW NEW Progress.Lang.AppError("table_write_not_ready", 0).
  IF pbOperation = "update" THEN pbIgnored = pbPrepareQuery().
  IF pbLimit = 0 THEN RETURN.
  DO TRANSACTION ON ERROR UNDO, THROW:
    IF pbOperation = "create" THEN DO:
      {write-create.i}
    END.
    ELSE DO:
      {write-update.i}
    END.
  END.
  FINALLY:
    pbIgnored = pbCleanup().
  END FINALLY.
END.
`;
}

export function renderInventory(inventory, domains) {
  const lines = [
    "/* Generated fixed-table metadata. */",
    "FUNCTION pbLoadInventory RETURNS LOGICAL ():",
    `  pbTable = "{&PB-TABLE}".`,
    "  CASE pbTable:"
  ];
  for (const table of inventory.tables) {
    const contract = sidecarFor(table, inventory);
    lines.push(
      `    WHEN ${quote(table.name)} THEN DO:`,
      `      ASSIGN pbPrimary = ${quote(table.primaryField)} pbSequence = ${quote(table.sequence)}.`
    );
    for (const [ordinal, field] of table.fields.entries()) {
      const width = Number(/x\((\d+)\)/i.exec(field.format ?? "")?.[1] ?? 0);
      const rel = field.relationship ?? {};
      const policy = field.writePolicy ?? {};
      lines.push(
        `      pbIgnored = pbAddField(${quote(field.name)}, ${ordinal + 1}, ${quote(field.type)}, ${width}, ${field.decimals ?? 0}, ${quote(rel.parentTable)}, ${quote(rel.parentField)}, ${rel.optional ? "TRUE" : "FALSE"}, ${field.lob?.defaultBytes ?? 0}, ${quote(policy.kind)}, ${quote(policy.value)}, ${quote(policy.values?.join("|") ?? "")}).`
      );
    }
    for (const item of contract.requiredTables)
      lines.push(`      pbIgnored = pbRequirement("table", ${quote(item.name)}, "", "").`);
    for (const field of contract.requiredFields) {
      const [qualified, type] = field.split(":");
      const [t, f] = qualified.split(".");
      lines.push(
        `      pbIgnored = pbRequirement("field", ${quote(t)}, ${quote(f)}, ${quote(type)}).`
      );
    }
    for (const index of contract.requiredIndexes) {
      const [t, i] = index.split(".");
      lines.push(`      pbIgnored = pbRequirement("index", ${quote(t)}, ${quote(i)}, "").`);
    }
    for (const index of table.indexes.filter((i) => i.unique && !i.primary))
      lines.push(
        `      pbIgnored = pbUnique(${quote(index.name)}, ${quote(index.components.map((c) => c.field ?? c.name).join(","))}).`
      );
    lines.push("    END.");
  }
  lines.push("  END CASE.");
  for (const [table, entries] of Object.entries(domains.tables)) {
    for (const [ordinal, entry] of entries.entries()) {
      const tuple = Object.entries(entry)
        .map(([key, val]) => `${key}=${val}`)
        .join("|");
      lines.push(`  pbIgnored = pbDomain(${quote(table)}, ${ordinal + 1}, ${quote(tuple)}).`);
    }
  }
  lines.push("  RETURN TRUE.", "END FUNCTION.", "");
  return lines.join("\n");
}

export function generate({
  scaffold = false,
  check = false,
  outputRoot = writeRoot,
  inventory = readInventory(),
  domains = readDomains()
} = {}) {
  if (scaffold && check) throw new Error("write_scaffold_check_conflict");
  validateInventory(inventory, { scaffold });
  validateDomains(inventory, domains);
  const outputs = new Map([["write-inventory.i", renderInventory(inventory, domains)]]);
  for (const table of inventory.tables) {
    outputs.set(`${table.name}.p`, renderWrapper(table, scaffold));
    outputs.set(
      `${table.name}.contract.json`,
      JSON.stringify(sidecarFor(table, inventory), null, 2) + "\n"
    );
  }
  // Validation above precedes all mutations. Check mode never creates directories.
  if (!check) fs.mkdirSync(outputRoot, { recursive: true });
  for (const [name, value] of outputs) {
    const target = path.join(outputRoot, name);
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== value)
        throw new Error(`write_generated_drift:${name}`);
    } else fs.writeFileSync(target, value);
  }
  if (scaffold)
    for (const name of [
      "write-common.i",
      "write-generators.i",
      "write-create.i",
      "write-update.i"
    ]) {
      const target = path.join(outputRoot, name);
      if (!fs.existsSync(target))
        fs.writeFileSync(
          target,
          "/* Handwritten implementation: scaffold does not overwrite this file. */\n"
        );
    }
  return { tables: inventory.tables.length, generatedFiles: outputs.size, scaffold, check };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((a) => !["--check", "--scaffold"].includes(a)))
      throw new Error("write_generator_arguments_invalid");
    console.log(
      JSON.stringify(
        generate({ check: args.includes("--check"), scaffold: args.includes("--scaffold") })
      )
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
