import { FailureKind, RunFailureCode } from "../../../../packages/contracts/src/run";
import { DATABASE_LATENCY_UNSUPPORTED_MESSAGE } from "../../../../packages/contracts/src/database-latency";

export interface ClassifiedRunError {
  failureKind: FailureKind;
  failureCode: RunFailureCode;
  failureReason: string;
}

const failureReasons: Record<RunFailureCode, { kind: FailureKind; reason: string }> = {
  database_writer_unavailable: { kind: "infrastructure", reason: "requested database writer capability is unavailable" },
  database_writer_capacity_insufficient: { kind: "infrastructure", reason: "database connection capacity cannot accommodate the requested writers" },
  database_bi_preparation_failed: { kind: "infrastructure", reason: "run-owned BI cluster preparation failed" },
  database_writer_start_failed: { kind: "infrastructure", reason: "the exact requested database writers could not be established" },
  database_run_control_unapplied: { kind: "infrastructure", reason: "observed database configuration does not match the frozen run controls" },
  database_writer_lost: { kind: "infrastructure", reason: "an expected database writer was lost during the run" },
  named_latch_evidence_missing: { kind: "observer", reason: "required named latch evidence could not be collected or verified" },
  observer_contract_invalid: {
    kind: "observer",
    reason: "configured OpenEdge observer schema or metric catalog is invalid"
  },
  observer_image_mismatch: {
    kind: "observer",
    reason: "configured OpenEdge observer image does not match the validated manifest"
  },
  pas_readiness_failed: {
    kind: "infrastructure",
    reason: "a configured PAS replica failed its application readiness check"
  },
  pas_readiness_timeout: {
    kind: "infrastructure",
    reason: "a configured PAS replica did not become ready before the timeout"
  },
  database_readiness_failed: {
    kind: "infrastructure",
    reason: "the run-owned database failed its readiness check"
  },
  database_readiness_timeout: {
    kind: "infrastructure",
    reason: "the run-owned database did not become ready before the timeout"
  },
  database_schema_invalid: {
    kind: "infrastructure",
    reason: "the run-owned database does not satisfy the workload's declared schema"
  },
  database_startup_source_changed: { kind: "infrastructure", reason: "selected seed or startup.pf changed after preview" },
  database_parameter_unapplied: { kind: "infrastructure", reason: "reviewed database broker value was not applied" },
  database_parameter_unverifiable: { kind: "observer", reason: "reviewed database broker value could not be verified" },
  database_parameter_capture_invalid: { kind: "observer", reason: "database parameter capture response is invalid" },
  database_parameter_metrics_unavailable: { kind: "export", reason: "database parameter metrics were not ingested or exported" },
  insufficient_disk_space: {
    kind: "infrastructure",
    reason: "the run root has less free space than one more seed copy plus 20% headroom"
  },
  database_latency_unsupported: {
    kind: "infrastructure",
    reason: DATABASE_LATENCY_UNSUPPORTED_MESSAGE
  },
  database_latency_apply_failed: {
    kind: "infrastructure",
    reason: "Database Latency could not be applied in a latency sidecar"
  },
  database_latency_unconfirmed: {
    kind: "infrastructure",
    reason: "the measured PAS-to-database round trip did not grow by the requested Database Latency"
  }
};

export function classifyRunError(error: unknown): ClassifiedRunError | undefined {
  const message = String(error).slice(0, 4096);
  let failureCode: RunFailureCode | undefined;
  const controlCode = (["database_writer_unavailable", "database_writer_capacity_insufficient",
    "database_bi_preparation_failed", "database_writer_start_failed", "database_run_control_unapplied",
    "database_writer_lost", "named_latch_evidence_missing"] as RunFailureCode[])
    .find(code => message.includes(code));
  if (
    controlCode
  ) failureCode = controlCode;
  else if (
    message.includes("observer_contract_invalid") ||
    message.includes("openedge_manifest_observer_contract_invalid")
  )
    failureCode = "observer_contract_invalid";
  else if (
    message.includes("observer_image_mismatch") ||
    message.includes("openedge_manifest_observer_image_mismatch")
  )
    failureCode = "observer_image_mismatch";
  else if (message.includes("database_schema_invalid")) failureCode = "database_schema_invalid";
  else if (message.includes("insufficient_disk_space")) failureCode = "insufficient_disk_space";
  else if (message.includes("database_startup_source_changed")) failureCode = "database_startup_source_changed";
  else if (message.includes("database_parameter_unapplied")) failureCode = "database_parameter_unapplied";
  else if (message.includes("database_parameter_unverifiable")) failureCode = "database_parameter_unverifiable";
  else if (message.includes("database_parameter_capture_invalid") || message.includes("openedge_db_parameter_capture_invalid"))
    failureCode = "database_parameter_capture_invalid";
  else if (message.includes("database_parameter_metrics_unavailable")) failureCode = "database_parameter_metrics_unavailable";
  else if (message.includes("run_readiness_timeout")) {
    failureCode = message.includes("database")
      ? "database_readiness_timeout"
      : "pas_readiness_timeout";
  } else if (message.includes("database_readiness_failed"))
    failureCode = "database_readiness_failed";
  else if (message.includes("pas_readiness_failed")) failureCode = "pas_readiness_failed";
  else if (message.includes("database_latency_unsupported")) failureCode = "database_latency_unsupported";
  else if (message.includes("database_latency_apply_failed")) failureCode = "database_latency_apply_failed";
  else if (message.includes("database_latency_unconfirmed")) failureCode = "database_latency_unconfirmed";
  if (!failureCode) return undefined;
  const { kind, reason } = failureReasons[failureCode];
  return { failureKind: kind, failureCode,
    failureReason: ["database_parameter_unapplied", "database_parameter_unverifiable",
      "database_startup_source_changed", "database_latency_apply_failed"].includes(failureCode) ? message.slice(0, 512) : reason.slice(0, 512) };
}
