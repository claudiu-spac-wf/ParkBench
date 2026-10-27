import Ajv2020 from "ajv/dist/2020";
import schema from "./schemas/database-analysis-report-v1.schema.json";
export const REPORT_VERSION = "database-analysis-report.v1" as const;
export const REPORT_VERSIONS = {
  parserVersion: "openedge-analysis-12.8.v1",
  columnsVersion: "database-analysis-columns.v1",
  csvVersion: "database-analysis-csv.v1",
  rulesVersion: "database-analysis-rules.v1"
} as const;
export const DATASET_KINDS = ["chain", "index", "table", "block", "lob"] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];
export type ReportType = "DBANALYS" | "IDXANALYS" | "TABANALYS";
export type ReportState = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export interface ReportRequest {
  contractVersion: typeof REPORT_VERSION;
  family: "database-analysis";
  seedAssetId: string;
  type: ReportType;
}
export const validateReportRequest = new Ajv2020({ allErrors: true }).compile<ReportRequest>(
  schema
);
export interface ReportFailure {
  code: string;
  message: string;
  correctiveAction: string;
  diagnosticLinks?: string[];
}
export interface ReportColumn {
  ordinal: number;
  sourceHeader: string;
  csvHeader: string;
  type: "text" | "integer" | "decimal";
  unit: string | null;
  description: string;
}
export interface ReportCell {
  columnId: number;
  originalHeader: string;
  semanticType: string;
  availabilityReason: string | null;
  assessments?: any[];
  sourceText: string;
  exact: string | null;
  unit: string | null;
  availability: "AVAILABLE" | "MISSING" | "INVALID";
}
export interface ReportRow {
  sourceRowOrdinal: number;
  objectKey: string;
  label: string;
  areaId: string;
  cells: ReportCell[];
  concern: string;
}
export interface ReportDataset {
  kind: DatasetKind;
  availability:
    "AVAILABLE" | "EMPTY" | "NOT_APPLICABLE" | "UNSUPPORTED" | "MISSING" | "NOT_COLLECTED";
  rowCount: string;
  complete: boolean;
  reason: string | null;
  columns: ReportColumn[];
  csvArtifactId?: string;
  sourceArtifactId?: string;
}
export interface ReportArtifact {
  id: string;
  reportId: string;
  kind: "SOURCE" | "CSV" | "DIAGNOSTIC" | "MANIFEST";
  datasetKind?: DatasetKind;
  filename: string;
  relativePath: string;
  mediaType: string;
  byteLength: string;
  complete: boolean;
}
export interface ReportMetadata {
  id: string;
  queueSequence: number;
  contractVersion: typeof REPORT_VERSION;
  family: "database-analysis";
  type: ReportType;
  state: ReportState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  seedSnapshot: {
    assetId: string;
    name: string;
    path: string;
    databaseName: string;
    managedRoot: string;
  };
  executionSnapshot: {
    image: string;
    observedVersion: string | null;
    options: string[];
    sourceEncoding: string;
    mounts: Array<{ source: string; target: string; readOnly: boolean }>;
    platformVersion: string;
  };
  parserVersion: string;
  columnsVersion: string;
  csvVersion: string;
  rulesVersion: string;
  failure: ReportFailure | null;
  warnings: ReportFailure[];
  projectionState: "PENDING" | "READY" | "PARTIAL" | "UNSUPPORTED" | "UNAVAILABLE";
  projectionRevision: string | null;
  cleanupState: "PENDING" | "CONFIRMED" | "FAILED";
  pendingTerminalState: Exclude<ReportState, "QUEUED" | "RUNNING"> | null;
  pendingFailure: ReportFailure | null;
  cleanupRetryAt: string | null;
  datasets: ReportDataset[];
  artifacts: ReportArtifact[];
}
export function terminalReport(state: ReportState): boolean {
  return !["QUEUED", "RUNNING"].includes(state);
}
