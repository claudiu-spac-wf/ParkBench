import { DATABASE_NAME_PATTERN, SeedDatabase } from "./seed";

/** Workload contract (feature 014, contracts/workload-contract-v1.md). */
export const WORKLOAD_CONTRACT_VERSION = "workload-contract.v1";

export interface WorkloadContractOperation {
  op: string;
  tables: string[];
  access: string;
  width?: number;
  bounds: { min: number; max: number };
}

export interface WorkloadContractV1 {
  contractVersion: typeof WORKLOAD_CONTRACT_VERSION;
  id: string;
  version: number;
  procedure: string;
  /** A logical database name, or "*" for a generic workload (tableScope "any"). */
  databaseName: string;
  /** "declared" (default): tables are listed. "any": a generic procedure reads any table. */
  tableScope?: "declared" | "any";
  requiredTables: Array<{ name: string; minimumRows: number }>;
  requiredFields?: string[];
  requiredIndexes?: string[];
  requiredSequences?: string[];
  input?: Record<string, unknown>;
  operations: WorkloadContractOperation[];
  writes?: { tables: string[]; scope?: string; cleanup?: string };
  readiness: { mode: "validate" | "none"; readOnly?: boolean; failurePrefix?: string };
  seedOwnership?: Record<string, unknown>;
}

function fail(rule: string): never {
  throw new Error(`workload_contract_invalid:${rule}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const CANONICAL_PROCEDURE = /^Workloads(?:\/[A-Za-z0-9_.-]+)+\.p$/;

function boundValue(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10000;
}

export function validateWorkloadContract(
  input: unknown,
  relativeProcedurePath?: string
): WorkloadContractV1 {
  if (!isRecord(input)) fail("object");
  if (input.contractVersion !== WORKLOAD_CONTRACT_VERSION) fail("contractVersion");
  if (typeof input.id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(input.id)) fail("id");
  if (!Number.isSafeInteger(input.version) || input.version < 1) fail("version");
  if (typeof input.procedure !== "string" || !CANONICAL_PROCEDURE.test(input.procedure))
    fail("procedure");
  if (input.procedure.split("/").some((part: string) => part === "." || part === ".."))
    fail("procedure");
  if (relativeProcedurePath !== undefined && input.procedure !== relativeProcedurePath)
    fail("procedure_path");
  if (input.tableScope !== undefined && !["declared", "any"].includes(input.tableScope))
    fail("tableScope");
  const anyScope = input.tableScope === "any";
  if (
    typeof input.databaseName !== "string" ||
    !(DATABASE_NAME_PATTERN.test(input.databaseName) || (anyScope && input.databaseName === "*"))
  )
    fail("databaseName");
  if (input.requiredTables === undefined && anyScope) input.requiredTables = [];
  if (
    !Array.isArray(input.requiredTables) ||
    (input.requiredTables.length === 0 && !anyScope)
  )
    fail("requiredTables");
  const required = new Set<string>();
  for (const table of input.requiredTables) {
    if (!isRecord(table) || typeof table.name !== "string" || !table.name)
      fail("requiredTables.name");
    if (!Number.isSafeInteger(table.minimumRows) || table.minimumRows < 0)
      fail("requiredTables.minimumRows");
    required.add(table.name);
  }
  for (const key of ["requiredFields", "requiredIndexes", "requiredSequences"])
    if (
      input[key] !== undefined &&
      (!Array.isArray(input[key]) || !input[key].every((item: unknown) => typeof item === "string"))
    )
      fail(key);
  if (!Array.isArray(input.operations) || input.operations.length === 0) fail("operations");
  const operationTables = new Set<string>();
  const ops = new Set<string>();
  for (const operation of input.operations) {
    if (!isRecord(operation) || typeof operation.op !== "string" || !operation.op)
      fail("operations.op");
    if (ops.has(operation.op)) fail("operations.unique");
    ops.add(operation.op);
    if (!Array.isArray(operation.tables) || operation.tables.length === 0)
      fail("operations.tables");
    if (anyScope && (operation.tables.length !== 1 || operation.tables[0] !== "*"))
      fail("operations.tables_any");
    for (const table of operation.tables) {
      if (!anyScope && !required.has(table)) fail(`operations.tables_required:${table}`);
      operationTables.add(table);
    }
    const bounds = operation.bounds;
    if (!isRecord(bounds) || !boundValue(bounds.min) || !boundValue(bounds.max))
      fail("operations.bounds");
    if (bounds.min > bounds.max) fail("operations.bounds_order");
  }
  if (input.writes !== undefined) {
    if (!isRecord(input.writes) || !Array.isArray(input.writes.tables)) fail("writes");
    if (anyScope && input.writes.tables.length > 0) fail("writes.any_scope");
    for (const table of input.writes.tables)
      if (!operationTables.has(table)) fail(`writes.tables_operation:${table}`);
  }
  if (!isRecord(input.readiness) || !["validate", "none"].includes(input.readiness.mode))
    fail("readiness.mode");
  if (input.readiness.mode === "validate" && input.readiness.readOnly !== true)
    fail("readiness.readOnly");
  if (anyScope && input.readiness.mode !== "none") fail("readiness.any_scope");
  return input as WorkloadContractV1;
}

/**
 * Pre-provision check of a workload contract against the selected seed. Only the database name is
 * known before the run starts; the required tables and rows are checked by the workload's own
 * `validate` mode against the run's copy during readiness.
 */
export function checkContractAgainstSeed(
  contract: WorkloadContractV1,
  seed: Pick<SeedDatabase, "databaseName">
): void {
  if (contract.databaseName === "*") return;
  if (contract.databaseName !== seed.databaseName) throw new Error("workload_database_mismatch");
}
