import {
  RunSummaryHeader,
  SummaryRow,
  StatisticValue,
  Statistic,
  METRIC_DEFINITIONS_VERSION
} from "./run-summary";
export const COMPARISON_CONTRACT_VERSION = "comparison.v2" as const;
export type SummaryCacheState = "READY" | "RECOMPUTING" | "LEGACY" | "UNAVAILABLE";
export interface ComparisonSelection {
  id: string;
  experimentId?: string;
  baselineRunId?: string;
  variantRunIds: string[];
  selectionRevision: number;
  dashboardContextId?: string;
  createdAt: string;
}
export interface ComparisonCreateRequest {
  experimentId?: string;
  baselineRunId?: string;
  variantRunIds: string[];
}
export interface SelectionPage {
  runIds: string[];
  nextCursor?: string;
  hasMore: boolean;
  returnedRunCount: number;
  totalSelectedRunCount: number;
}
export interface RowPage {
  rows: SummaryRow[];
  nextCursor?: string;
  hasMore: boolean;
  returnedRowCount: number;
  totalRowCount: number;
  attemptToken?: string;
  semanticVersion?: string;
}
export interface SummaryReadResult {
  status: SummaryCacheState;
  reason?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  header?: RunSummaryHeader;
  attemptToken?: string;
  artifactId?: string;
  artifactPath?: string;
  legacyReferences?: Array<{ id: string; path: string }>;
}
export interface SummaryReader {
  read(runId: string): SummaryReadResult;
  page(
    runId: string,
    options?: { cursor?: string; limit?: number; tablesOnly?: boolean; nonTablesOnly?: boolean }
  ): RowPage;
  find(runId: string, rowKey: string): SummaryRow | undefined;
  iterate(runId: string): AsyncIterable<SummaryRow>;
  tableUnionCount?(runId: string, baselineRunId?: string): number;
}
export interface SummaryScheduler {
  schedule(runId: string): void;
}
export interface Difference {
  value: number | null;
  baseline: number | null;
  absoluteDifference: number | null;
  percentageDifference: number | null;
  reason?: string;
}
export interface ComparisonRow {
  row: SummaryRow;
  baselineRow?: SummaryRow;
  differences: Partial<Record<Statistic, Difference>>;
}
export interface ComparisonRunResult {
  runId: string;
  experimentId: string;
  scenario?: { id: string; version?: string; fingerprint?: string };
  name?: string;
  role: "BASELINE" | "VARIANT";
  state: string;
  measurementValidity: string;
  summary: SummaryReadResult;
  rows: ComparisonRow[];
  tablePage: {
    nextCursor?: string;
    hasMore: boolean;
    returnedRowCount: number;
    totalRowCount: number;
  };
  context?: Record<string, unknown>;
}
export interface ComparisonResult {
  contractVersion: typeof COMPARISON_CONTRACT_VERSION;
  id: string;
  experimentId?: string;
  baselineRunId?: string;
  selectionRevision: number;
  totalSelectedRunCount: number;
  selectionEndpoint: string;
  selectionPage: SelectionPage;
  dashboardContextId?: string;
  createdAt: string;
  runs: ComparisonRunResult[];
  warnings: Array<{ code: "different_scenarios"; message: string }>;
  page: {
    nextCursor?: string;
    hasMore: boolean;
    returnedRunCount: number;
    totalSelectedRunCount: number;
  };
  retryAfterSeconds?: number;
}

export interface ComparisonTablePage {
  id: string;
  runId: string;
  selectionRevision: number;
  rows: ComparisonRow[];
  nextCursor?: string;
  hasMore: boolean;
  returnedRowCount: number;
  totalRowCount: number;
  attemptToken?: string;
  baselineAttemptToken?: string;
}
