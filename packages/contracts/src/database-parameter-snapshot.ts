import Ajv from "ajv/dist/2020";
import { loadContractSchema } from "./schema-loader";
import type { DatabaseStartupParameter } from "./database-startup";

export const DATABASE_PARAMETER_SNAPSHOT_CONTRACT_VERSION = "db-parameter-snapshot.v1" as const;

export interface DatabaseParameterSnapshotRow {
  name: string;
  displayValue: string | null;
  valueStatus: "recorded" | "unknown";
  numericValue?: number;
  dtype: number | null;
  isDefault: false;
  isModifiable?: boolean | null;
}

export interface DatabaseParameterSnapshot {
  contractVersion: typeof DATABASE_PARAMETER_SNAPSHOT_CONTRACT_VERSION;
  runId: string;
  experimentId: string;
  variantId: string;
  repetition: number;
  databaseName: string;
  attemptedAt: string;
  capturedAt?: string;
  status: "complete" | "empty" | "partial" | "unavailable";
  reason?: string;
  gaps?: string[];
  rowCount: number;
  source: "_DbParams";
  rows: DatabaseParameterSnapshotRow[];
  verificationResults: Array<Pick<DatabaseStartupParameter,
    "name" | "displayValue" | "source" | "verification" | "observedValue" | "reason">>;
}

const validate = new Ajv({ allErrors: true, strict: false }).compile<DatabaseParameterSnapshot>(
  loadContractSchema("db-parameter-snapshot-v1")
);

export function validateDatabaseParameterSnapshot(input: unknown): DatabaseParameterSnapshot {
  if (!validate(input)) throw new Error(`database_parameter_snapshot_invalid:${JSON.stringify(validate.errors)}`);
  const snapshot = input as DatabaseParameterSnapshot;
  if (snapshot.rowCount !== snapshot.rows.length ||
    (snapshot.status === "empty" && snapshot.rowCount !== 0) ||
    (snapshot.status === "complete" && snapshot.rowCount === 0) ||
    (snapshot.status === "unavailable" && snapshot.rowCount !== 0) ||
    ((snapshot.status === "complete" || snapshot.status === "empty") && !snapshot.capturedAt) ||
    (snapshot.status === "unavailable" && snapshot.capturedAt !== undefined) ||
    (snapshot.gaps?.length && snapshot.status !== "partial"))
    throw new Error("database_parameter_snapshot_state_invalid");
  const names = new Set<string>();
  for (const row of snapshot.rows) {
    if (names.has(row.name) || (row.valueStatus === "recorded") !== (row.displayValue !== null) ||
      (row.numericValue !== undefined && !Number.isFinite(row.numericValue)))
      throw new Error("database_parameter_snapshot_row_invalid");
    names.add(row.name);
  }
  return snapshot;
}
