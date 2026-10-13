export const METRIC_DEFINITIONS_VERSION = "measurement-summary.v1" as const;
export const RESOURCE_METRICS_VERSION = "resource-metrics.v2" as const;
export const SUMMARY_REASONS = [
  "not_configured",
  "unsupported",
  "not_licensed",
  "not_collected",
  "temporarily_unavailable",
  "insufficient_data",
  "measurement_not_started",
  "measurement_boundaries_missing",
  "expired",
  "source_unavailable",
  "required_member_missing",
  "counter_reset_gap",
  "conflicting_observation",
  "coverage_mismatch",
  "legacy_semantics",
  "run_not_finalized",
  "summary_limit_exceeded",
  "query_timeout",
  "persistence_failed"
] as const;
export type SummaryReason = (typeof SUMMARY_REASONS)[number];
export type ResourceGroup = "platform" | "database" | "pas";
export type Statistic = "average" | "p90" | "p95" | "total";
export type StatisticStatus = "available" | "estimated" | "partial" | "unavailable";
export const SUMMARY_DIMENSIONS = [
  "service",
  "replica",
  "table",
  "pool",
  "direction",
  "operation",
  "file",
  "scope"
] as const;
export interface MetricDefinition {
  definitionId: string;
  displayName: string;
  group: ResourceGroup;
  sourceMetricNames: string[];
  type: "counter" | "gauge";
  sourceUnit: string;
  rateOrLevelUnit: string;
  totalUnit: string | null;
  coverageScope: string;
  allowedDimensions: readonly string[];
  required: boolean;
  supportedStatistics: Statistic[];
  authoritativePublisher: string;
  sourceContractVersion: string;
  scale?: number;
  totalScale?: number;
  catalogOrder?: number;
}
export interface ResourceMembership {
  group: ResourceGroup;
  service: string;
  replica?: string;
  physicalId: string;
  epoch: string;
  activeIntervals: Array<{ start: number; end: number }>;
  sourceJob: string;
  sourceStepSeconds: number;
  freshness?: {
    captureMetric?: string;
    kind: "capture_timestamp" | "uncached_scrape";
    latencySeconds?: number;
  };
}
export interface Coverage {
  coverageModel: "single_source" | "shared_member_intersection" | "constituent_additive";
  durationSeconds: number;
  observedSeconds: number;
  estimatedEdgeSeconds: number;
  missingSeconds: number;
  sourceStepSeconds: number;
  observationStepSeconds: number;
  percentileBinCount: number;
  omittedBinCount: number;
  expectedAcquisitions: number;
  observedAcquisitions: number;
  reasons: SummaryReason[];
  supportedContributors?: number;
  incompleteContributors?: number;
  constituentSelector?: {
    definitionIds: string[];
    group: ResourceGroup;
    coverageScope: string;
    dimensions?: Record<string, string>;
  };
}
export interface StatisticValue {
  value: number | null;
  status: StatisticStatus;
  reasons: SummaryReason[];
  unit: string;
  coverage: Coverage;
  observedTotal?: number;
  estimatedTotal?: number;
}
export interface SummaryRow {
  rowKey: string;
  definitionId: string;
  group: ResourceGroup;
  displayName: string;
  coverageScope: string;
  dimensions: Record<string, string>;
  rateOrLevelUnit: string;
  totalUnit: string | null;
  statistics: Partial<Record<Statistic, StatisticValue>>;
  coverage: Coverage;
  sourceReferences: Array<{
    metric: string;
    source?: string;
    query?: string;
    contractVersion?: string;
  }>;
  catalogOrder?: number;
}
