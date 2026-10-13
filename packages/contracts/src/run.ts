export const RUN_STATES = [
  "QUEUED",
  "PROVISIONING",
  "DB_READY",
  "PAS_READY",
  "WARMING_UP",
  "MEASURING",
  "COOLDOWN",
  "FINALIZING",
  "SUCCEEDED",
  "INCOMPLETE",
  "THRESHOLD_FAILED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
] as const;
export type RunState = (typeof RUN_STATES)[number];
export type MeasurementValidity = "PENDING" | "VALID" | "INCOMPLETE" | "UNAVAILABLE";
export type FailureKind =
  "infrastructure" | "threshold" | "cancellation" | "observer" | "export" | "interruption";
export const RUN_FAILURE_CODES = [
  "observer_contract_invalid",
  "observer_image_mismatch",
  "pas_readiness_failed",
  "pas_readiness_timeout",
  "database_readiness_failed",
  "database_readiness_timeout",
  "database_schema_invalid",
  "database_startup_source_changed",
  "database_parameter_unapplied",
  "database_parameter_unverifiable",
  "database_parameter_capture_invalid",
  "database_parameter_metrics_unavailable",
  "insufficient_disk_space",
  "database_latency_unsupported",
  "database_latency_apply_failed",
  "database_latency_unconfirmed",
  "database_writer_unavailable",
  "database_writer_capacity_insufficient",
  "database_bi_preparation_failed",
  "database_writer_start_failed",
  "database_run_control_unapplied",
  "database_writer_lost",
  "named_latch_evidence_missing"
] as const;
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];
export interface CompletenessResult {
  complete: boolean;
  requiredGaps: Array<{
    observerId: string;
    phase: string;
    expected: number;
    observed: number;
    missing: number;
    measurementId?: string;
    metricName?: string;
    source?: string;
    availability?:
      | "unsupported"
      | "not_configured"
      | "not_licensed"
      | "not_collected"
      | "temporarily_unavailable";
    availabilityReason?: string;
  }>;
  optionalWarnings: string[];
  evidence?: Array<{
    observerId: string;
    phase: string;
    longestGapSeconds?: number;
    lastSuccessAt?: string;
  }>;
}
export interface Run {
  id: string;
  name?: string;
  experimentId: string;
  variantId: string;
  repetition: number;
  state: RunState;
  measurementValidity: MeasurementValidity;
  composeProject: string;
  resourceNamespace: Record<string, string>;
  environmentSnapshot?: Record<string, unknown>;
  imageSnapshots?: Record<string, import("./image-reference").ImageIdentitySnapshot>;
  phase?: string;
  startedAt?: string;
  measuringAt?: string;
  finishedAt?: string;
  failureKind?: FailureKind;
  failureCode?: RunFailureCode;
  failureReason?: string;
  completeness?: CompletenessResult;
  summary?: Record<string, unknown>;
  observerHealth?: Record<string, unknown>;
  phaseBoundaries?: Partial<
    Record<
      "warmup" | "measurement" | "cooldown",
      {
        startedAt: string;
        finishedAt?: string;
      }
    >
  >;
  cleanupStatus: "PENDING" | "COMPLETE" | "PARTIAL" | "FAILED";
}
export interface LifecycleEvent {
  id: number;
  runId: string;
  fromState: RunState;
  toState: RunState;
  occurredAt: string;
  actor: "controller" | "operator" | "reconciler";
  reason: string;
  details?: Record<string, unknown>;
}
