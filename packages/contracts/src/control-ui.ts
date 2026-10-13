import {
  CatalogAssetKind,
  CatalogAvailability,
  CatalogCategoryKey,
  CatalogClassificationState,
  CatalogReadiness,
  DiscoveryRefreshState,
  DiscoverySourceState,
  ServiceHealthState
} from "./catalog";

export const CONTROL_UI_CONTRACT_VERSION = "control-ui.v1" as const;
export const EXPERIMENT_SCHEDULE_CONTRACT_VERSION = "experiment-schedule.v2" as const;
export const UI_OPTIONS_CONTRACT_VERSION = "ui-options.v1" as const;

export interface CredentialReferenceOption {
  reference: string;
  label: string;
}

export interface UiOptionsV1 {
  contractVersion: typeof UI_OPTIONS_CONTRACT_VERSION;
  databaseParameters?: import("./database-parameter-options").DatabaseParameterCapabilities;
  /** Platform run parameters such as Database Latency (feature 016). */
  runParameters?: DatabaseParameterDefinition[];
  credentialReferences?: CredentialReferenceOption[];
}

export type {
  CatalogAssetKind,
  CatalogAvailability,
  CatalogCategoryKey,
  CatalogClassificationState,
  CatalogReadiness,
  DiscoveryRefreshState,
  DiscoverySourceState,
  ServiceHealthState
};

export type VerificationState = "UNVERIFIED" | "VERIFYING" | "VERIFIED" | "STALE" | "FAILED";

export interface CatalogAsset {
  id: string;
  kind: CatalogAssetKind;
  category?: CatalogCategoryKey;
  name: string;
  description?: string;
  version?: string;
  immutableRef?: string;
  compatibility?: Record<string, unknown>;
  sourceRef?: string;
  provenance?: Record<string, unknown>;
  availability?: CatalogAvailability;
  readiness?: CatalogReadiness;
  classificationState?: CatalogClassificationState;
  blockReasons?: string[];
  discoverySource?: "docker" | "filesystem";
  discoveryIdentity?: string;
  discoveredAt?: string;
  lastSeenAt?: string;
  discoveryError?: { code: string; message: string };
  verificationState: VerificationState;
  verifiedAt?: string;
  verificationOperationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoverySourceStatus {
  source: "docker" | "filesystem";
  rootKey?: Exclude<CatalogCategoryKey, "docker_images">;
  state: DiscoverySourceState;
  itemCount: number;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  error?: { code: string; message: string };
}

export interface CatalogCategorySummary {
  key: CatalogCategoryKey;
  label: string;
  count: number;
  readyCount: number;
  staleCount: number;
  sourceState: DiscoverySourceState;
}

export interface CatalogDiscoverySnapshot {
  contractVersion: "catalog-discovery.v1";
  refreshedAt?: string;
  refreshState: DiscoveryRefreshState;
  categories: CatalogCategorySummary[];
  sources: DiscoverySourceStatus[];
}

export interface OverviewSnapshot {
  contractVersion: "overview.v1";
  health: {
    sqlite: ServiceHealthState;
    docker: ServiceHealthState;
    prometheus: ServiceHealthState;
    checkedAt: string;
  };
  discovery: CatalogDiscoverySnapshot;
  queue: {
    activeExperiment: string | null;
    queued: number;
    running: number;
    blocked: number;
    nextRetryAt: string | null;
  };
  recentRuns: Array<{
    id: string;
    experimentId: string;
    state: string;
    updatedAt: string;
    summary?: Record<string, unknown>;
  }>;
}

export type ParameterScalar = string | number | boolean;
export type ParameterDependencyOperator =
  "eq" | "neq" | "in" | "notIn" | "gt" | "gte" | "lt" | "lte";

export interface ParameterDependencyRule {
  parameter: string;
  operator: ParameterDependencyOperator;
  value: ParameterScalar | ParameterScalar[];
}

export interface DatabaseParameterDefinition {
  id: string;
  canonicalName: string;
  type: "integer" | "number" | "string" | "boolean" | "enum";
  defaultValue?: string | number | boolean;
  allowedValues?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  step?: number;
  unit?: string;
  description: string;
  explanation?: string;
  source: string;
  dependencies?: ParameterDependencyRule[];
  matrixAllowed: boolean;
  secret: false;
  definitionVersion: string;
}

export interface ScenarioVersionRecord {
  id: string;
  version: string;
  document: Record<string, unknown>;
  parameterDefinitions: DatabaseParameterDefinition[];
  state: "DRAFT" | "READY" | "RETIRED";
  createdAt: string;
  retiredAt?: string;
}

export interface MatrixDimension {
  name: string;
  values: Array<string | number | boolean>;
}

export interface MatrixPreviewRequest {
  runName: string;
  displayName?: string;
  scenario: { id: string; version: string };
  scenarioSourceId?: string;
  dimensions: MatrixDimension[];
  repetitions: number;
  fixedOverrides?: Record<string, string | number | boolean>;
  inputs?: Record<string, unknown>;
}

export interface MatrixPreviewRequestV2 {
  contractVersion: typeof EXPERIMENT_SCHEDULE_CONTRACT_VERSION;
  runName: string;
  scenarioSourceId: string;
  dimensions: MatrixDimension[];
  repetitions: number;
  fixedOverrides?: Record<string, string | number | boolean>;
  inputs: { seed: string; applicationArchive: string };
}

export interface MatrixCell {
  runName?: string;
  ordinal: number;
  values: Record<string, string | number | boolean>;
  repetition: number;
  effectiveConfiguration: Record<string, string | number | boolean>;
  databaseStartup?: import("./database-startup").DatabaseStartupParameters;
  /** Additive immutable configuration records; legacy cells omit them. */
  databaseRunControls?: import("./database-run-controls").DatabaseRunControls;
}

export interface MatrixPreview {
  previewId: string;
  scenario: { id: string; version: string };
  cellCount: number;
  runCount: number;
  confirmationRequired: true;
  warning: { code: string; message: string };
  cells: { items: MatrixCell[]; nextPageToken?: string; hasMore: boolean };
  review: { loadedRunCount: number; complete: boolean };
  expiresAt: string;
}

export type QueueState =
  | "QUEUED"
  | "BLOCKED"
  | "RUNNING"
  | "SUCCEEDED"
  | "THRESHOLD_FAILED"
  | "FAILED"
  | "CANCELLED"
  | "INCOMPLETE"
  | "INTERRUPTED";

export interface ControlRunView {
  databaseRunControlEvidence?: Record<string, unknown>;
  id: string;
  name?: string;
  startedAt?: string;
  queuedAt?: string;
  experimentId: string;
  cellOrdinal: number;
  repetition: number;
  values: Record<string, string | number | boolean>;
  effectiveConfiguration: Record<string, string | number | boolean>;
  state: QueueState | string;
  queueState: QueueState | string;
  blockedReason?: string;
  nextRetryAt?: string;
  retryCount: number;
  snapshot: Record<string, unknown>;
  updatedAt: string;
}

export interface ControlExperimentView {
  id: string;
  name?: string;
  scenario: { id: string; version: string };
  previewId: string;
  cellCount: number;
  runCount: number;
  status: string;
  queueOrdinal: number;
  baselineRunId?: string;
  createdAt: string;
  runs: ControlRunView[];
}

export type ImageOperationKind = "BUILD" | "VERIFY";
export type ImageOperationState =
  "REQUESTED" | "VALIDATING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface ImageOperation {
  id: string;
  kind: ImageOperationKind;
  stage?: string;
  inputAssetIds: string[];
  expectedContracts: string[];
  outputProfile?: string;
  commandId: string;
  state: ImageOperationState;
  progress: { phase: string; percent: number };
  diagnostics: string[];
  logs: string[];
  outputAssetIds: string[];
  failureCode?: string;
  failureReason?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ComparisonView {
  selectionRevision?: number;
  id: string;
  experimentId?: string;
  baselineRunId?: string;
  variantRunIds: string[];
  eligibility: "VALID" | "DESCRIPTIVE_ONLY" | "REJECTED";
  eligibilityReasons: string[];
  sharedContext: Record<string, unknown>;
  runs: Array<Record<string, unknown>>;
  dashboardContextId?: string;
  createdAt: string;
}

export interface DashboardContext {
  id: string;
  experimentId?: string;
  runIds: string[];
  baselineRunId?: string;
  phase?: string;
  metricScope: string[];
  dashboardRefs: Array<{ dashboardId: string; panelIds: string[] }>;
  variables: Record<string, string[]>;
  timeRange?: { from: string; to: string };
  /** Elapsed-time range (epoch ms on the aligned axis) for several runs; grafana-runs-datasource.v1. */
  alignedTimeRange?: { from: number; to: number };
  availability: "available" | "degraded" | "unavailable" | "expired";
  health?: {
    grafana: boolean;
    prometheus: boolean;
    labelsValid: boolean;
    metricsAvailability?: Record<string, "available" | "expired" | "unavailable" | "not_started">;
    checkedAt: string;
  };
  grafanaUrl?: string;
  expiresAt: string;
}

export interface ControlUiErrorShape {
  error: {
    code: string;
    message: string;
    fields?: Array<{ path: string; code: string }>;
    requestId?: string;
  };
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type {
  ComparisonResult,
  ComparisonSelection,
  ComparisonRow,
  ComparisonRunResult,
  SelectionPage,
  SummaryReader,
  SummaryScheduler
} from "./comparison";
