import { DatabaseSync } from "node:sqlite";
import Ajv from "ajv/dist/2020";
import { loadContractSchema } from "./schema-loader";
import { Run } from "./run";
import {
  SummaryRow,
  Coverage,
  ResourceMembership,
  METRIC_DEFINITIONS_VERSION
} from "./metric-definitions";
export * from "./metric-definitions";
export const SUMMARY_HEADER_LIMIT = 2 * 1024 * 1024,
  SUMMARY_ROW_LIMIT = 16 * 1024,
  RUN_CONTEXT_LIMIT = 4 * 1024 * 1024;
export interface MeasurementWindow {
  start: string | null;
  end: string | null;
  state: "completed" | "interrupted" | "not_started";
  durationSeconds: number;
}
export interface RunSummaryHeader {
  contractVersion: "run-summary.v1";
  metricDefinitionsVersion: typeof METRIC_DEFINITIONS_VERSION;
  run: Pick<
    Run,
    "id" | "name" | "experimentId" | "variantId" | "repetition" | "state" | "measurementValidity"
  >;
  generatedAt: string;
  origin: "new_run" | "historical_recompute";
  windows: { run: { start: string | null; end: string | null }; measurement: MeasurementWindow };
  sampling: {
    baseStepSeconds: number;
    observationStepSeconds: number;
    sources: any[];
    boundaryEstimation: string;
  };
  quality: {
    complete: boolean;
    requiredGaps: any[];
    optionalWarnings: string[];
    cleanupStatus: Run["cleanupStatus"];
    failureReason?: string;
    failureKind?: string;
  };
  memberships: ResourceMembership[];
  workload: Record<string, unknown>;
  observerHealth: Record<string, unknown>;
  metricsReference: { source: string; queries: any[]; labelKeys: string[]; [key: string]: unknown };
  contextReference: { path: string; artifactId?: string; [key: string]: unknown };
  totalRowCount: number;
  tableRowCount: number;
  expectedTableCount?: number;
  observedTableCount?: number;
}
export interface RunContext {
  contractVersion: "run-context.v1";
  runId: string;
  scenario: Record<string, unknown>;
  requested: Record<string, unknown>;
  effective: Record<string, unknown>;
  observed: Record<string, unknown>;
  inputs: Record<string, unknown>;
  loadSeed: string | number;
  host: Record<string, unknown>;
  tools: Record<string, unknown>;
  images: Record<string, unknown>;
  sources: any[];
  capturedAt: string;
  finalizedAt?: string;
  health?: Record<string, unknown>;
  parameterReference?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}
const ajv = new Ajv({ allErrors: true, strict: false, strictNumbers: true });
const schema = loadContractSchema("run-summary-v1");
const headerValidator = ajv.compile(schema);
const rowValidator = ajv.compile((schema.$defs as any).row);
const contextValidator = ajv.compile(loadContractSchema("run-context-v1"));
export function semanticRowKey(
  row: Pick<
    SummaryRow,
    "definitionId" | "group" | "coverageScope" | "rateOrLevelUnit" | "totalUnit" | "dimensions"
  >
): string {
  return JSON.stringify([
    row.definitionId,
    row.group,
    row.coverageScope,
    row.rateOrLevelUnit,
    row.totalUnit,
    Object.entries(row.dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  ]);
}
function finite(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("summary_non_finite");
  if (value && typeof value === "object") for (const v of Object.values(value)) finite(v);
}
function check(value: unknown, validator: any, limit: number, label: string): void {
  finite(value);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > limit)
    throw new Error("summary_limit_exceeded:" + label);
  if (!validator(value))
    throw new Error("summary_contract_invalid:" + label + ":" + ajv.errorsText(validator.errors));
}
function coverage(c: Coverage): void {
  if (
    Math.abs(c.observedSeconds + c.estimatedEdgeSeconds + c.missingSeconds - c.durationSeconds) >
    0.002
  )
    throw new Error("coverage_mismatch");
  if (
    c.coverageModel === "constituent_additive" &&
    c.incompleteContributors > c.supportedContributors + 1024 * 1024
  )
    throw new Error("coverage_mismatch");
}
export function validateSummaryHeader(
  value: unknown,
  owner?: string
): asserts value is RunSummaryHeader {
  check(value, headerValidator, SUMMARY_HEADER_LIMIT, "header");
  const h = value as RunSummaryHeader;
  if ("rows" in h) throw new Error("summary_header_contains_rows");
  if (owner !== undefined && h.run.id !== owner) throw new Error("summary_owner_mismatch");
  const w = h.windows.measurement;
  if (w.state === "not_started") {
    if (w.start !== null || w.end !== null || w.durationSeconds !== 0)
      throw new Error("measurement_window_invalid");
  } else if (
    w.start === null ||
    w.end === null ||
    !Number.isFinite(Date.parse(w.start)) ||
    !Number.isFinite(Date.parse(w.end)) ||
    Date.parse(w.end) < Date.parse(w.start) ||
    Math.abs((Date.parse(w.end) - Date.parse(w.start)) / 1000 - w.durationSeconds) > 0.002
  )
    throw new Error("measurement_window_invalid");
  if (h.tableRowCount > h.totalRowCount) throw new Error("summary_count_mismatch");
}
export function validateSummaryRow(value: unknown): asserts value is SummaryRow {
  check(value, rowValidator, SUMMARY_ROW_LIMIT, "row");
  const r = value as SummaryRow;
  if (r.rowKey !== semanticRowKey(r)) throw new Error("summary_row_identity_invalid");
  coverage(r.coverage);
  for (const [key, s] of Object.entries(r.statistics)) {
    coverage(s.coverage);
    if (s.value === null && (s.reasons.length === 0 || s.status !== "unavailable"))
      throw new Error("summary_null_reason_required");
    if (s.value !== null && s.status === "unavailable")
      throw new Error("summary_unavailable_numeric");
    if (s.unit !== (key === "total" ? r.totalUnit : r.rateOrLevelUnit))
      throw new Error("summary_unit_mismatch");
    if (
      key === "total" &&
      (r.totalUnit === null ||
        (s.value !== null &&
          (s.observedTotal === undefined ||
            s.estimatedTotal === undefined ||
            Math.abs(s.value - s.observedTotal - s.estimatedTotal) >
              Math.max(1e-8, Math.abs(s.value) * 1e-10))))
    )
      throw new Error("summary_total_invalid");
  }
}
export function validateRunContext(value: unknown, owner?: string): asserts value is RunContext {
  check(value, contextValidator, RUN_CONTEXT_LIMIT, "context");
  if (owner && (value as RunContext).runId !== owner) throw new Error("summary_owner_mismatch");
}
/** Duplicate detection spills to SQLite rather than retaining every row/key in memory. */
export class SummaryStreamValidator {
  private readonly seen = new DatabaseSync("");
  private count = 0;
  private tables = 0;
  constructor(
    private readonly header: RunSummaryHeader,
    owner?: string
  ) {
    validateSummaryHeader(header, owner);
    this.seen.exec("PRAGMA cache_size=-1024; CREATE TABLE seen(key TEXT PRIMARY KEY)");
  }
  append(row: SummaryRow): void {
    validateSummaryRow(row);
    try {
      this.seen.prepare("INSERT INTO seen VALUES(?)").run(row.rowKey);
    } catch {
      throw new Error("summary_duplicate_row");
    }
    this.count++;
    if (row.dimensions.table) this.tables++;
  }
  finish(): void {
    if (this.count !== this.header.totalRowCount || this.tables !== this.header.tableRowCount)
      throw new Error("summary_count_mismatch");
  }
  close(): void {
    this.seen.close();
  }
}
export async function validateSummaryStream(
  header: RunSummaryHeader,
  rows: AsyncIterable<SummaryRow> | Iterable<SummaryRow>,
  owner?: string
): Promise<void> {
  const validator = new SummaryStreamValidator(header, owner);
  try {
    for await (const row of rows) validator.append(row);
    validator.finish();
  } finally {
    validator.close();
  }
}
