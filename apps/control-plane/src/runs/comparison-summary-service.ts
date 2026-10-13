import fs from "node:fs";
import nativeCatalog from "../../../../packages/contracts/src/openedge-db-metric-catalog.json";
import type { Run } from "../../../../packages/contracts/src/run";
import type {
  RunSummaryHeader,
  MeasurementWindow,
  SummaryRow
} from "../../../../packages/contracts/src/run-summary";
import {
  METRIC_DEFINITIONS_VERSION,
  validateSummaryHeader
} from "../../../../packages/contracts/src/run-summary";
import {
  PrometheusClient,
  MeasurementBuildOptions,
  resolveMeasurementWindow,
  readRawChunks,
  resolveResourceMembership,
  expectedResourceMembers,
  missingResourceMembers,
  buildResourceSummaryRows,
  buildDatabaseSummaryRows,
  DatabaseInventory,
  RESOURCE_SUMMARY_CATALOG,
  MAX_PERCENTILE_BINS,
  verifyRequiredSources,
  finalizationQueryOptions
} from "../../../../packages/metrics/src";
import { Repositories } from "../db/repositories";
import { ArtifactStorage } from "../artifacts/storage";
import { writeStagedSummary } from "../artifacts/summary-stream";
import { persistRunContext } from "./run-context";
export interface PreparedSummary {
  token?: string;
  header: RunSummaryHeader;
  hasSupportedValues: boolean;
  signal?: AbortSignal;
  releaseLease?: () => void;
}
export interface PrepareSummaryOptions {
  origin: "new_run" | "historical_recompute";
  signal?: AbortSignal;
  window?: MeasurementWindow;
  priority?: "finalization" | "historical";
  attemptToken?: string;
}
export class ComparisonSummaryService {
  constructor(
    private readonly repositories: Repositories,
    private readonly storage: ArtifactStorage,
    private readonly prometheus: PrometheusClient,
    private readonly defaultCadence = 5
  ) {}
  async prepare(run: Run, request: PrepareSummaryOptions): Promise<PreparedSummary> {
    const version = METRIC_DEFINITIONS_VERSION,
      existing = this.repositories.getSummaryCache(run.id);
    if (existing?.status === "READY") return { header: existing.header!, hasSupportedValues: true };
    let window: MeasurementWindow;
    try {
      window = request.window ?? resolveMeasurementWindow(run);
    } catch (error) {
      if (request.origin === "historical_recompute") throw error;
      window = { start: null, end: null, state: "interrupted", durationSeconds: 0 };
    }
    const token = request.attemptToken ?? this.repositories.claimSummaryAttempt(run.id);
    if (!token) throw new Error("summary_attempt_busy");
    this.repositories.assertSummaryAttempt(run.id, version, token);
    const jobSignal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000),
      signal =
        request.origin === "new_run"
          ? AbortSignal.any([jobSignal, finalizationQueryOptions(run).signal!])
          : jobSignal,
      e = (run.environmentSnapshot as any) ?? {},
      cadence = Number(e.sourceCadences?.prometheusScrapeSeconds ?? this.defaultCadence) || 5,
      nativeCadence = Math.max(
        cadence,
        Number(e.sourceCadences?.nativeDatabaseRefreshSeconds ?? cadence) || cadence
      ),
      queries: MeasurementBuildOptions["queries"] = [
        ...(e.requiredSourceVerification?.queries ?? [])
      ],
      optionalWarnings = new Set<string>(),
      requiredGaps: any[] = [...(run.completeness?.requiredGaps ?? [])];
    const lease = setInterval(() => {
      try {
        this.repositories.renewSummaryAttempt(run.id, version, token);
      } catch {
        /* Publication and each staging operation enforce current ownership. */
      }
    }, 30000);
    lease.unref();
    let handedOff = false;
    try {
      const sourceSamples: any[] = [];
      if (request.origin === "new_run") {
        const verification = await verifyRequiredSources(this.prometheus, run, window, cadence, {
          signal,
          priority: "finalization"
        });
        requiredGaps.push(...verification.gaps);
        queries.push(...verification.queries);
        for (const warning of verification.optionalWarnings) optionalWarnings.add(warning);
      }
      let inventory: DatabaseInventory = {
        protocolVersion: String(e.metricContracts?.nativeDb ?? "").includes("v4")
          ? 4
          : String(e.metricContracts?.nativeDb ?? "").includes("v3")
            ? 3
            : 2,
        tables: []
      };
      if (
        window.state !== "not_started" &&
        window.start &&
        window.end &&
        window.durationSeconds > 0
      ) {
        const start = Date.parse(window.start!) / 1000,
          end = Date.parse(window.end!) / 1000;
        for (const selector of [
          `container_start_time_seconds{job="parkbench-run-owned-cadvisor",run_id=${JSON.stringify(run.id)}}`,
          ...(request.origin === "historical_recompute"
            ? [
                `container_start_time_seconds{job="cadvisor",container_label_parkbench_run_id=${JSON.stringify(run.id)}}`
              ]
            : []),
          `container_start_time_seconds{job="cadvisor",container_label_com_docker_compose_project="parkbench-platform",container_label_com_docker_compose_service!=""}`
        ]) {
          try {
            for await (const chunk of readRawChunks(
              this.prometheus,
              selector,
              start,
              end,
              cadence,
              { signal, priority: request.priority }
            )) {
              sourceSamples.push(...chunk.samples);
              if (sourceSamples.length > 100000)
                throw new Error("summary_limit_exceeded:memberships");
              queries.push({ selector: chunk.query, start: chunk.start, end: chunk.end });
            }
          } catch (error) {
            optionalWarnings.add("membership:" + this.reason(error));
          }
        }
        // One recent native inventory snapshot carries every actual name, even excluded objects.
        try {
          const selector = `parkbench_openedge_db_metric_available{job="parkbench-runs",run_id=${JSON.stringify(run.id)},measurement="table_operations_total"}`,
            latest = new Map<string, any>();
          for await (const chunk of readRawChunks(
            this.prometheus,
            selector,
            Math.max(start, end - nativeCadence * 2),
            end,
            nativeCadence,
            { signal, priority: request.priority }
          )) {
            queries.push({ selector: chunk.query, start: chunk.start, end: chunk.end });
            for (const s of chunk.samples) {
              const key = JSON.stringify([s.labels.table, s.labels.operation]);
              if (!latest.has(key) || latest.get(key).timestamp < s.timestamp) latest.set(key, s);
            }
          }
          const values = [...latest.values()];
          inventory = {
            ...inventory,
            tables: [
              ...new Set<string>(
                values
                  .filter((s) => s.labels.table && (s.labels.table !== "other" || s.value === 1))
                  .map((s) => s.labels.table)
              )
            ].sort(),
            availability: values.map((s) => ({
              table: s.labels.table,
              operation: s.labels.operation,
              availability:
                s.value === 1
                  ? "available"
                  : s.labels.reason === "statistics_range_excludes_object"
                    ? "not_configured"
                    : s.labels.reason === "field_missing" || s.labels.reason === "vst_missing"
                      ? "unsupported"
                      : "not_collected",
              reason: s.labels.reason
            }))
          };
          if (!inventory.tables.length) optionalWarnings.add("database_inventory:not_collected");
        } catch (error) {
          optionalWarnings.add("database_inventory:" + this.reason(error));
        }
      }
      const memberships =
        window.state === "not_started" || !window.start || !window.end
          ? []
          : resolveResourceMembership(
              sourceSamples,
              run.id,
              Date.parse(window.start!) / 1000,
              Date.parse(window.end!) / 1000,
              cadence,
              this.repositories.listResources(run.id),
              request.origin === "new_run",
              Number(e.sourceCadences?.cadvisorHousekeepingSeconds) || 0
            );
      const expectedMembers = expectedResourceMembers(run, this.repositories.listResources(run.id));
      if (window.state !== "not_started" && window.durationSeconds > 0)
        for (const member of missingResourceMembers(expectedMembers, memberships))
          requiredGaps.push({
            observerId: member.group,
            phase: "measurement",
            expected: 1,
            observed: 0,
            missing: 1,
            measurementId: member.service,
            availability: "not_collected",
            availabilityReason: "required_member_missing"
          });
      const options: MeasurementBuildOptions = {
        run,
        historical: request.origin === "historical_recompute",
        window,
        memberships,
        expectedMembers,
        sourceStepSeconds: cadence,
        cadvisorHousekeepingSeconds: Number(e.sourceCadences?.cadvisorHousekeepingSeconds) || 0,
        nativeStepSeconds: nativeCadence,
        priority:
          request.priority ?? (request.origin === "new_run" ? "finalization" : "historical"),
        signal,
        queries
      };
      let hasSupportedValues = false;
      const stage = async (rows: AsyncIterable<SummaryRow>) => {
        let batch: SummaryRow[] = [];
        for await (const row of rows) {
          signal.throwIfAborted();
          this.repositories.assertSummaryAttempt(run.id, version, token);
          if (Object.values(row.statistics).some((s) => s.value !== null))
            hasSupportedValues = true;
          const required = RESOURCE_SUMMARY_CATALOG.find(
            (d) => d.definitionId === row.definitionId && d.group === row.group
          )?.required;
          if (
            required &&
            window.state !== "not_started" &&
            (!row.statistics.average ||
              row.statistics.average.value === null ||
              row.coverage.missingSeconds > 1e-8)
          )
            requiredGaps.push({
              observerId: row.group,
              phase: "measurement",
              expected: row.coverage.expectedAcquisitions || 1,
              observed: row.coverage.observedAcquisitions,
              missing: Math.max(
                1,
                (row.coverage.expectedAcquisitions || 1) - row.coverage.observedAcquisitions
              ),
              metricName: row.sourceReferences[0]?.metric,
              measurementId: row.rowKey
            });
          else if (Object.values(row.statistics).some((s) => s.value === null))
            optionalWarnings.add(`${row.definitionId}:insufficient_data`);
          batch.push(row);
          if (batch.length === 64) {
            this.repositories.stageSummaryRows(run.id, version, token, batch);
            batch = [];
          }
        }
        if (batch.length) this.repositories.stageSummaryRows(run.id, version, token, batch);
      };
      await stage(buildResourceSummaryRows(this.prometheus, options));
      await stage(buildDatabaseSummaryRows(this.prometheus, options, inventory));
      signal.throwIfAborted();
      const counts = this.repositories.summaryRowCounts(run.id, version, token),
        step =
          cadence *
          Math.max(1, Math.ceil(window.durationSeconds / (MAX_PERCENTILE_BINS * cadence))),
        workload = this.workload(run);
      const header: RunSummaryHeader = {
        contractVersion: "run-summary.v1",
        metricDefinitionsVersion: version,
        run: {
          id: run.id,
          name: run.name,
          experimentId: run.experimentId,
          variantId: run.variantId,
          repetition: run.repetition,
          state: run.state,
          measurementValidity: run.measurementValidity
        },
        generatedAt: new Date().toISOString(),
        origin: request.origin,
        windows: {
          run: { start: run.startedAt ?? null, end: run.finishedAt ?? null },
          measurement: window
        },
        sampling: {
          baseStepSeconds: cadence,
          observationStepSeconds: step,
          sources: [
            {
              job: "cadvisor",
              acquisitionSeconds: cadence,
              sourceTimestampLagSeconds: options.cadvisorHousekeepingSeconds
            },
            {
              job: "parkbench-run-owned-cadvisor",
              acquisitionSeconds: cadence,
              sourceTimestampLagSeconds: options.cadvisorHousekeepingSeconds
            },
            {
              job: "parkbench-runs",
              acquisitionSeconds: nativeCadence,
              contractVersion: `openedge-db-observer.v${inventory.protocolVersion}`
            }
          ],
          boundaryEstimation:
            "nearest wholly in-phase segment; edge tail <= source cadence plus recorded source timestamp lag; no internal-gap fill"
        },
        quality: {
          complete: window.state === "completed" && requiredGaps.length === 0,
          requiredGaps,
          optionalWarnings: [...optionalWarnings],
          cleanupStatus: run.cleanupStatus,
          failureReason: run.failureReason,
          failureKind: run.failureKind
        },
        memberships,
        workload,
        observerHealth: run.observerHealth ?? {},
        metricsReference: {
          expectedMembers,
          source: (this.prometheus as any).baseUrl ?? "retained_prometheus",
          queries,
          diagnosticSelectors: [
            {
              selector: `{run_id=${JSON.stringify(run.id)}${run.environmentSnapshot?.metricsCollectionMode === "continuous" ? "" : ',phase="measurement"'}}`,
              purpose: "all retained run-tagged diagnostic families"
            },
            ...nativeCatalog.entries.map((entry) => ({
              selector: `parkbench_openedge_db_${entry.name}{run_id=${JSON.stringify(run.id)}}`,
              family: entry.family,
              dimensions: entry.dimensions,
              type: entry.type,
              unit: entry.unit
            })),
            {
              selector: `parkbench_openedge_pas_requests_total{run_id=${JSON.stringify(run.id)}}`,
              purpose: "canonical PAS request/failure/POST/ABL diagnostics"
            },
            {
              selector: `parkbench_workload_request_duration_seconds_bucket{run_id=${JSON.stringify(run.id)}}`,
              purpose: "workload latency histogram with operation and le"
            }
          ],
          labelKeys: [
            ...new Set([
              "run_id",
              "phase",
              "service",
              "replica",
              "pool",
              "table",
              "operation",
              "database_epoch",
              ...queries.flatMap((q) => (q as any).labelKeys ?? [])
            ])
          ].sort()
        },
        contextReference: { path: `${run.id}/run-context.v1.json` },
        totalRowCount: counts.total,
        tableRowCount: counts.tables,
        expectedTableCount: inventory.tables.length,
        observedTableCount: inventory.tables.filter((t) =>
          inventory.availability?.some((a) => a.table === t && a.availability === "available")
        ).length
      };
      validateSummaryHeader(header, run.id);
      handedOff = true;
      return {
        token,
        header,
        hasSupportedValues,
        signal,
        releaseLease: () => clearInterval(lease)
      };
    } catch (error) {
      try {
        this.repositories.failSummaryAttempt(
          run.id,
          version,
          token,
          "UNAVAILABLE",
          this.reason(error),
          true
        );
      } catch {
        /* A replacement attempt owns its state. */
      }
      throw error;
    } finally {
      if (!handedOff) clearInterval(lease);
    }
  }
  async publish(run: Run, prepared: PreparedSummary) {
    if (!prepared.token) return this.repositories.getSummaryCache(run.id);
    const header: RunSummaryHeader = {
      ...prepared.header,
      run: {
        ...prepared.header.run,
        state: run.state,
        measurementValidity: run.measurementValidity
      },
      windows: {
        ...prepared.header.windows,
        run: { start: run.startedAt ?? null, end: run.finishedAt ?? null }
      },
      quality: {
        ...prepared.header.quality,
        cleanupStatus: run.cleanupStatus,
        failureReason: run.failureReason,
        failureKind: run.failureKind
      }
    };
    try {
      this.repositories.assertSummaryAttempt(
        run.id,
        header.metricDefinitionsVersion,
        prepared.token
      );
      if (
        header.origin === "new_run" ||
        !fs.existsSync(this.storage.safePath(header.contextReference.path))
      ) {
        const context = persistRunContext(run, this.storage, this.repositories, true);
        header.contextReference.artifactId = context.id;
      }
      const artifact = await writeStagedSummary(
        this.storage,
        this.repositories,
        header,
        prepared.token,
        prepared.signal
      );
      this.repositories.publishSummary(
        run.id,
        header.metricDefinitionsVersion,
        prepared.token,
        header,
        artifact
      );
      return this.repositories.getSummaryCache(run.id);
    } catch (error) {
      try {
        this.repositories.failSummaryAttempt(
          run.id,
          header.metricDefinitionsVersion,
          prepared.token,
          "UNAVAILABLE",
          "persistence_failed",
          true
        );
      } catch {
        /* Preserve replacement/READY pointer. */
      }
      throw error;
    } finally {
      prepared.releaseLease?.();
    }
  }
  async reconcileOrphan(runId: string): Promise<boolean> {
    const cache = this.repositories.getSummaryCache(runId);
    if (cache?.status !== "RECOMPUTING" || !cache.attemptToken || cache.leaseUntil <= Date.now())
      return false;
    const recovered = await this.storage.recoverSummaryAttempt(
      runId,
      METRIC_DEFINITIONS_VERSION,
      cache.attemptToken,
      this.repositories.iterateStagedSummaryRows(
        runId,
        METRIC_DEFINITIONS_VERSION,
        cache.attemptToken
      )
    );
    if (!recovered) return false;
    this.repositories.publishSummary(
      runId,
      METRIC_DEFINITIONS_VERSION,
      cache.attemptToken,
      recovered.header,
      recovered.artifact
    );
    return true;
  }
  private reason(error: unknown) {
    return String(error).includes("summary_limit_exceeded")
      ? "summary_limit_exceeded"
      : String(error).includes("query_timeout") || String(error).includes("TimeoutError")
        ? "query_timeout"
        : String(error).includes("measurement_boundaries_missing")
          ? "measurement_boundaries_missing"
          : "source_unavailable";
  }
  private workload(run: Run): Record<string, unknown> {
    const filename = this.storage.safePath(`${run.id}/loadgen-summary.json`);
    if (fs.existsSync(filename)) {
      if (fs.statSync(filename).size > 1024 * 1024)
        throw new Error("summary_limit_exceeded:workload");
      const content = fs.readFileSync(filename, "utf8");
      // Loadgen creates its destination before readiness. A pre-measurement
      // failure can leave it empty; retain a useful not-started summary.
      if (!content.trim())
        return { availability: "not_collected", reason: "loadgen_summary_empty" };
      const value = JSON.parse(content);
      if (value.runId && value.runId !== run.id) throw new Error("loadgen_summary_owner_invalid");
      return value;
    }
    return (run.environmentSnapshot as any)?.loadgenSummary ?? {};
  }
}
