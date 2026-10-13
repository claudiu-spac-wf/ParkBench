import { purgeConsolidatedProducers } from "../artifacts/retention";
import { ComparisonSummaryService, PreparedSummary } from "./comparison-summary-service";
import { persistRunContext } from "./run-context";
import { Run } from "../../../../packages/contracts/src/run";
import {
  PrometheusClient,
  queryRunMeasurement,
  verifyRequiredRunSamples,
  finalizationQueryOptions,
  recordVerificationQuery
} from "../../../../packages/metrics/src";
import { Repositories } from "../db/repositories";
import { saveDiagnostics } from "../artifacts/diagnostics";
import {
  privateInputValues,
  redactSecrets,
  runtimeSecretValues
} from "../../../../packages/contracts/src/redaction";
import { ArtifactStorage } from "../artifacts/storage";
import { artifactRecord } from "../artifacts/manifest";
import { summarize } from "../../../../packages/metrics/src/summarizer";
import { persistRunEvidence } from "./evidence";
import { validateDatabaseParameterSnapshot } from "../../../../packages/contracts/src/database-parameter-snapshot";
import { parameterSnapshotSamples } from "../../../../packages/observers/src/openedge-db/parameter-metrics";
import type { MetricSample } from "../../../../packages/contracts/src/metrics";
export interface FinalizeOptions {
  terminalState: Run["state"];
  start: number;
  end: number;
  measurementState?: "not_started" | "completed" | "interrupted";
  measurementStart?: number | null;
  measurementEnd?: number | null;
  beforeMetrics?: () => Promise<void> | void;
  cleanup?: () => Promise<void> | void;
  collectLogs?: () => Promise<string | Buffer> | string | Buffer;
}
export class Finalizer {
  constructor(
    private readonly repositories: Repositories,
    private readonly storage: ArtifactStorage,
    private readonly prometheus: PrometheusClient,
    /** Prometheus scrape interval: the step for reading a run's measurement window back. */
    private readonly scrapeIntervalSeconds = 1,
    private readonly comparisonSummaries = new ComparisonSummaryService(
      repositories,
      storage,
      prometheus,
      scrapeIntervalSeconds
    )
  ) {}
  async finalize(run: Run, options: FinalizeOptions): Promise<Run> {
    let prepared: PreparedSummary | undefined;
    let acquisitionAttempted = false;
    if (
      run.environmentSnapshot &&
      !(run.environmentSnapshot as any).measurementWindow &&
      options.measurementState
    )
      (run.environmentSnapshot as any).measurementWindow = {
        state: options.measurementState,
        start: run.phaseBoundaries?.measurement?.startedAt ?? null,
        end: run.phaseBoundaries?.measurement?.finishedAt ?? null
      };
    this.saveRun(run);
    try {
      await options.beforeMetrics?.();
      if (options.collectLogs) {
        try {
          const logs = await options.collectLogs();
          const inputReferences = Object.entries(
            ((run.environmentSnapshot as any)?.inputs ?? {}) as Record<string, unknown>
          )
            .filter(
              ([key, value]) =>
                ["seed", "applicationArchive", "databaseImage", "pasImage"].includes(key) &&
                typeof value === "string" &&
                !value.startsWith("input:")
            )
            .map(([, value]) => value as string);
          const text = Buffer.isBuffer(logs) ? logs.toString("utf8") : String(logs);
          // copy-seed.sh reports how long the run-owned seed copy took (feature 014, SC-008).
          const seedCopy = /seed_copy_seconds=(\d+)/.exec(text);
          if (seedCopy && run.environmentSnapshot) {
            (run.environmentSnapshot as any).seedCopySeconds = Number(seedCopy[1]);
            this.repositories.saveRun(run);
          }
          const privateInputs = privateInputValues(
            Object.values(
              ((run.environmentSnapshot as any)?.inputs ?? {}) as Record<string, unknown>
            )
          );
          const redacted = redactSecrets(text, [
            ...runtimeSecretValues(),
            ...inputReferences,
            ...privateInputs
          ]) as string;
          const logFile = this.storage.write(`${run.id}/service-logs.txt`, redacted);
          this.repositories.saveArtifact(artifactRecord(run.id, "log", logFile, "text"));
        } catch (error) {
          this.saveDiagnostics(run, {
            code: "service_log_collection_failed",
            error: String(error)
          });
        }
      }
      // The run's time series stay in Prometheus (constitution 4.0.0). Check the required
      // parameter snapshot series are there, then read back only the measurement window.
      const required = this.requiredStartupSamples(run);
      if (required?.length)
        await verifyRequiredRunSamples(
          this.prometheus,
          {
            runId: run.id,
            start: options.start,
            end: options.end,
            stepSeconds: this.scrapeIntervalSeconds
          },
          required,
          finalizationQueryOptions(run),
          (query) => recordVerificationQuery(run, query)
        );
      acquisitionAttempted = true;
      prepared = await this.comparisonSummaries.prepare(run, {
        origin: "new_run",
        priority: "finalization"
      });
      if (run.environmentSnapshot)
        (run.environmentSnapshot as any).metrics = prepared.header.metricsReference;
      run.completeness = {
        complete: prepared.header.quality.complete,
        requiredGaps: prepared.header.quality.requiredGaps,
        optionalWarnings: prepared.header.quality.optionalWarnings,
        evidence: run.completeness?.evidence
      };
      if (
        prepared.header.quality.requiredGaps.some((g) =>
          String(g.observerId).startsWith("required-source:")
        )
      ) {
        run.failureKind ??= "observer";
        run.failureReason ??=
          "required Prometheus measurements unavailable: " +
          prepared.header.quality.requiredGaps
            .filter((g) => String(g.observerId).startsWith("required-source:"))
            .map((g) => `${g.metricName}:${g.availabilityReason}`)
            .join(", ");
        this.saveDiagnostics(run, {
          code: "required_run_metrics_unavailable",
          gaps: run.completeness.requiredGaps
        });
      }
    } catch (error) {
      const fromState = run.state;
      const failureState = ["FAILED", "CANCELLED", "INTERRUPTED", "THRESHOLD_FAILED"].includes(options.terminalState)
        ? options.terminalState
        : "FAILED";
      run.state = failureState;
      run.measurementValidity = "UNAVAILABLE";
      run.failureKind ??= acquisitionAttempted ? "export" : "observer";
      run.failureReason ??= String(error);
      run.finishedAt = new Date().toISOString();
      this.saveRun(run);
      this.saveEvent(run, {
        runId: run.id,
        fromState,
        toState: failureState,
        occurredAt: new Date().toISOString(),
        actor: "controller",
        reason: "run metrics could not be read from Prometheus"
      });
      this.saveDiagnostics(
        run,
        {
          code: "run_metrics_unavailable",
          error: String(error),
          terminalStateRequested: options.terminalState
        },
        privateInputValues(
          Object.values(((run.environmentSnapshot as any)?.inputs ?? {}) as Record<string, unknown>)
        )
      );
      if (!acquisitionAttempted) {
        run.completeness = {
          complete: false,
          requiredGaps: [
            ...(run.completeness?.requiredGaps ?? []),
            {
              observerId: "required-source-verification",
              phase: "measurement",
              expected: 1,
              observed: 0,
              missing: 1
            }
          ],
          optionalWarnings: run.completeness?.optionalWarnings ?? []
        };
        try {
          prepared = await this.comparisonSummaries.prepare(run, {
            origin: "new_run",
            priority: "finalization"
          });
        } catch (acquisitionError) {
          this.recordFinalization(run, {
            stage: "summary_acquisition_failed",
            error: String(acquisitionError)
          });
        }
      }
      await this.cleanup(run, options);
      await this.publishSummary(run, prepared);
      return run;
    }
    const namedMissing =
      run.completeness?.requiredGaps.some((g) => g.observerId === "required-source:named-latch") ??
      false;
    if (namedMissing) {
      if (options.terminalState === "SUCCEEDED") {
        run.failureKind = "observer";
        run.failureCode = "named_latch_evidence_missing";
        run.failureReason = "required named latch evidence could not be collected or verified";
      }
      this.saveDiagnostics(run, {
        code: "named_latch_evidence_missing",
        gaps: run.completeness!.requiredGaps
      });
    }
    const fromState = run.state;
    const terminalState =
      namedMissing && options.terminalState === "SUCCEEDED"
        ? "FAILED"
        : options.terminalState === "SUCCEEDED" &&
            prepared?.header.windows.measurement.state !== "not_started" &&
            !prepared?.header.quality.complete
          ? "INCOMPLETE"
          : options.terminalState;
    run.state = terminalState;
    run.measurementValidity =
      namedMissing ? "UNAVAILABLE" : terminalState === "INCOMPLETE"
        ? "INCOMPLETE"
        : ["FAILED", "CANCELLED", "INTERRUPTED"].includes(terminalState)
          ? "UNAVAILABLE"
          : "VALID";
    run.finishedAt = new Date().toISOString();
    this.saveRun(run);
    this.saveEvent(run, {
      runId: run.id,
      fromState,
      toState: terminalState,
      occurredAt: new Date().toISOString(),
      actor: "controller",
      reason: `run finalized as ${terminalState}`
    });
    await this.cleanup(run, options);
    await this.publishSummary(run, prepared);
    return run;
  }

  private requiredStartupSamples(run: Run): MetricSample[] | undefined {
    const capture = (run.environmentSnapshot as any)?.parameterSnapshotCapture;
    if (capture?.state !== "captured") return undefined;
    const relativePath = `${run.id}/${capture.artifact ?? "db-parameter-snapshot.json"}`;
    const snapshot = validateDatabaseParameterSnapshot(
      JSON.parse(this.storage.read(relativePath).toString("utf8"))
    );
    if (
      snapshot.runId !== run.id ||
      snapshot.experimentId !== run.experimentId ||
      snapshot.variantId !== run.variantId ||
      snapshot.repetition !== run.repetition
    )
      throw new Error("run_metrics_snapshot_identity_mismatch");
    return parameterSnapshotSamples(snapshot, {
      runId: run.id,
      experimentId: run.experimentId,
      variantId: run.variantId,
      repetition: run.repetition,
      phase: "idle"
    }).filter((sample) =>
      [
        "parkbench_openedge_db_parameter_snapshot_status",
        "parkbench_openedge_db_parameter_snapshot_info",
        "parkbench_openedge_db_parameter_snapshot_timestamp_seconds"
      ].includes(sample.metricName)
    );
  }

  private async cleanup(run: Run, options: FinalizeOptions): Promise<void> {
    if (!options.cleanup) {
      run.cleanupStatus = "PENDING";
      this.saveDiagnostics(run, {
        code: "cleanup_not_configured",
        terminalState: run.state
      });
      this.saveRun(run);
      this.recordFinalization(run, { stage: "cleanup", status: run.cleanupStatus });
      return;
    }
    try {
      await options.cleanup();
      run.cleanupStatus = "COMPLETE";
    } catch (error) {
      run.cleanupStatus = "FAILED";
      this.saveDiagnostics(run, {
        code: "cleanup_failed",
        error: String(error)
      });
    }
    run.phase = run.state.toLowerCase();
    this.saveRun(run);
    this.recordFinalization(run, { stage: "cleanup", status: run.cleanupStatus });
  }

  private saveRun(run: Run): void {
    try {
      this.repositories.saveRun(run);
    } catch (error) {
      this.recordFinalization(run, {
        stage: "database_run_update_failed",
        error: String(error)
      });
    }
  }

  private saveEvent(run: Run, event: Parameters<Repositories["saveEvent"]>[0]): void {
    try {
      this.repositories.saveEvent(event);
    } catch (error) {
      this.recordFinalization(run, {
        stage: "database_lifecycle_event_failed",
        error: String(error)
      });
    }
  }

  private saveDiagnostics(run: Run, diagnostics: unknown, additionalSecrets: string[] = []): void {
    try {
      saveDiagnostics(this.storage, this.repositories, run.id, diagnostics, additionalSecrets);
    } catch (error) {
      this.recordFinalization(run, {
        stage: "diagnostics_artifact_registration_failed",
        error: String(error)
      });
    }
  }

  private async publishSummary(run: Run, prepared?: PreparedSummary): Promise<void> {
    try {
      if (!prepared) throw new Error("summary_acquisition_failed_before_cleanup");
      await this.comparisonSummaries.publish(run, prepared);
      purgeConsolidatedProducers(this.storage, run);
    } catch (error) {
      this.recordFinalization(run, { stage: "summary_persistence_failed", error: String(error) });
      try {
        persistRunContext(run, this.storage, this.repositories, true);
      } catch (contextError) {
        this.recordFinalization(run, {
          stage: "context_persistence_failed",
          error: String(contextError)
        });
      }
    }
  }

  private recordFinalization(run: Run, entry: Record<string, unknown>): void {
    try {
      const relativePath = `${run.id}/finalization-status.json`;
      let previous: Record<string, any> = {};
      try {
        previous = JSON.parse(this.storage.read(relativePath).toString("utf8"));
      } catch {
        // A missing or incomplete sidecar starts a new recovery record.
      }
      const errors = Array.isArray(previous.errors) ? previous.errors : [];
      const safeEntry = redactSecrets(entry, runtimeSecretValues());
      this.storage.write(
        relativePath,
        JSON.stringify(
          {
            contractVersion: "run-finalization.v1",
            runId: run.id,
            state: run.state,
            cleanupStatus: run.cleanupStatus,
            updatedAt: new Date().toISOString(),
            errors: entry.stage === "cleanup" ? errors : [...errors, safeEntry]
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(`run_finalization_status_write_failed:${run.id}:${String(error)}`);
    }
  }
}

// 0/1 flags that summaries add nothing to: OpenEdge availability (kept in the run evidence and
// in Prometheus) and node-exporter's per-mount filesystem flags.
const UNSUMMARIZED_METRICS = new Set([
  "parkbench_openedge_db_metric_available",
  "node_filesystem_device_error",
  "node_filesystem_readonly"
]);
// cAdvisor copies every Docker label onto each container series (about 50). The summary keeps
// only those that identify the container, so it stays small and compares across runs.
const KEPT_CONTAINER_LABELS = new Set([
  "container_label_com_docker_compose_service",
  "container_label_com_docker_compose_container_number",
  "container_label_parkbench_run_id",
  "container_label_parkbench_component"
]);

/** The measurement samples a run summary is built from (feature 014, research R14). */
export function summaryInput(samples: MetricSample[]): MetricSample[] {
  return samples
    .filter((sample) => !UNSUMMARIZED_METRICS.has(sample.metricName))
    .map((sample) => {
      if (!Object.keys(sample.labels).some((key) => key.startsWith("container_label_")))
        return sample;
      const labels = Object.fromEntries(
        Object.entries(sample.labels).filter(
          ([key]) => !key.startsWith("container_label_") || KEPT_CONTAINER_LABELS.has(key)
        )
      );
      return { ...sample, labels: labels as MetricSample["labels"] };
    });
}
