import crypto from "node:crypto";
import type { StatementSync } from "node:sqlite";
import fs from "node:fs";
import {
  SummaryRow,
  RunSummaryHeader,
  validateSummaryHeader,
  validateSummaryRow,
  METRIC_DEFINITIONS_VERSION
} from "../../../../packages/contracts/src/run-summary";
import {
  RowPage,
  SummaryCacheState,
  SummaryReadResult
} from "../../../../packages/contracts/src/comparison";
import { SummaryArtifact, verifySummaryArtifact } from "../artifacts/manifest";
import { DatabaseClient } from "./client";
import {
  Artifact,
  Experiment,
  LifecycleEvent,
  Run,
  Variant
} from "../../../../packages/contracts/src";
import { RunState } from "../../../../packages/contracts/src/run";
const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T>(value: any): T => (typeof value === "string" ? JSON.parse(value) : value);
export class Repositories {
  constructor(public readonly client: DatabaseClient) {}
  private summaryAttemptStatement?: StatementSync;
  private summaryInsertStatement?: StatementSync;

  getSummaryCache(
    runId: string,
    version: string = METRIC_DEFINITIONS_VERSION
  ):
    | (SummaryReadResult & {
        attemptToken: string;
        leaseUntil: number;
        updatedAt: string;
        totalRowCount: number;
        tableRowCount: number;
      })
    | undefined {
    const row: any = this.client.db
      .prepare("SELECT * FROM run_comparison_summaries WHERE run_id=? AND semantic_version=?")
      .get(runId, version);
    if (!row) return undefined;
    return {
      status: row.status,
      reason: row.reason_code ?? undefined,
      retryable: !!row.retryable,
      header: row.status === "READY" ? parse(row.document) : undefined,
      attemptToken: row.status === "READY" ? row.published_attempt_token : row.attempt_token,
      leaseUntil: row.lease_until,
      updatedAt: row.updated_at,
      totalRowCount: row.total_row_count,
      tableRowCount: row.table_row_count,
      artifactId: row.status === "READY" ? row.artifact_id : undefined,
      artifactPath: row.status === "READY" ? row.artifact_path : undefined
    };
  }
  claimSummaryAttempt(
    runId: string,
    version: string = METRIC_DEFINITIONS_VERSION,
    now = Date.now()
  ): string | undefined {
    if (!this.getRun(runId)) throw new Error("run_not_found");
    const token = crypto.randomUUID(),
      time = new Date(now).toISOString();
    return this.summaryTransaction(() => {
      const current = this.getSummaryCache(runId, version);
      if (
        current?.status === "READY" ||
        (current?.status === "RECOMPUTING" && current.leaseUntil > now)
      )
        return undefined;
      this.client.db
        .prepare(
          `INSERT INTO run_comparison_summaries(run_id,semantic_version,status,attempt_token,lease_until,requested_at,updated_at)
       VALUES(?,?,'RECOMPUTING',?,?,?,?) ON CONFLICT(run_id,semantic_version) DO UPDATE SET status='RECOMPUTING',attempt_token=excluded.attempt_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at,document=NULL,reason_code=NULL,retryable=0`
        )
        .run(runId, version, token, now + 150000, time, time);
      return token;
    });
  }
  assertSummaryAttempt(runId: string, version: string, token: string, now = Date.now()): void {
    // This check runs for every streamed row. Reuse the native statement rather
    // than allocating thousands of statements awaiting garbage collection.
    this.summaryAttemptStatement ??= this.client.db.prepare(
      "SELECT status,attempt_token,lease_until FROM run_comparison_summaries WHERE run_id=? AND semantic_version=?"
    );
    const r: any = this.summaryAttemptStatement.get(runId, version);
    if (!r || r.status !== "RECOMPUTING" || r.attempt_token !== token || r.lease_until <= now)
      throw new Error("summary_attempt_stale");
  }
  renewSummaryAttempt(runId: string, version: string, token: string): void {
    this.assertSummaryAttempt(runId, version, token);
    this.client.db
      .prepare(
        "UPDATE run_comparison_summaries SET lease_until=?,updated_at=? WHERE run_id=? AND semantic_version=? AND attempt_token=?"
      )
      .run(Date.now() + 150000, new Date().toISOString(), runId, version, token);
  }
  stageSummaryRows(runId: string, version: string, token: string, rows: SummaryRow[]): void {
    if (rows.length > 64) throw new Error("summary_limit_exceeded:staging_batch");
    rows.forEach(validateSummaryRow);
    this.summaryTransaction(() => {
      this.assertSummaryAttempt(runId, version, token);
      const insert = (this.summaryInsertStatement ??= this.client.db.prepare(
        "INSERT INTO run_comparison_summary_rows(run_id,semantic_version,attempt_token,row_key,table_name,group_order,catalog_order,dimension_order,document) VALUES(?,?,?,?,?,?,?,?,?)"
      ));
      for (const row of rows)
        insert.run(
          runId,
          version,
          token,
          row.rowKey,
          row.dimensions.table ?? null,
          { platform: 0, database: 1, pas: 2 }[row.group],
          row.catalogOrder ?? 0,
          JSON.stringify(
            Object.entries(row.dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          ),
          json(row)
        );
    });
  }
  summaryRowCounts(
    runId: string,
    version: string,
    token: string
  ): { total: number; tables: number } {
    const result: any = this.client.db
      .prepare(
        "SELECT count(*) AS total,coalesce(sum(table_name IS NOT NULL),0) AS tables FROM run_comparison_summary_rows WHERE run_id=? AND semantic_version=? AND attempt_token=?"
      )
      .get(runId, version, token);
    return { total: Number(result.total), tables: Number(result.tables) };
  }
  async *iterateStagedSummaryRows(
    runId: string,
    version: string,
    token: string,
    batchSize = 64
  ): AsyncGenerator<SummaryRow> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64)
      throw new Error("summary_limit_exceeded:staging_batch");
    let offset = 0;
    const select = this.client.db.prepare(
      "SELECT document FROM run_comparison_summary_rows WHERE run_id=? AND semantic_version=? AND attempt_token=? ORDER BY group_order,catalog_order,dimension_order,row_key LIMIT ? OFFSET ?"
    );
    while (true) {
      this.assertSummaryAttempt(runId, version, token);
      const rows = select.all(runId, version, token, batchSize, offset) as any[];
      if (!rows.length) return;
      for (const row of rows) {
        this.assertSummaryAttempt(runId, version, token);
        const value = parse<SummaryRow>(row.document);
        validateSummaryRow(value);
        yield value;
      }
      offset += rows.length;
    }
  }
  publishSummary(
    runId: string,
    version: string,
    token: string,
    header: RunSummaryHeader,
    artifact: SummaryArtifact
  ): void {
    validateSummaryHeader(header, runId);
    if (header.metricDefinitionsVersion !== version) throw new Error("summary_version_mismatch");
    verifySummaryArtifact(artifact, header, token);
    this.summaryTransaction(() => {
      this.assertSummaryAttempt(runId, version, token);
      const counts = this.summaryRowCounts(runId, version, token);
      if (counts.total !== header.totalRowCount || counts.tables !== header.tableRowCount)
        throw new Error("summary_count_mismatch");
      this.saveArtifact(artifact);
      this.client.db
        .prepare(
          `UPDATE run_comparison_summaries SET status='READY',document=?,artifact_id=?,artifact_path=?,published_attempt_token=?,lease_until=NULL,completed_at=?,updated_at=?,total_row_count=?,table_row_count=?,reason_code=NULL,retryable=0 WHERE run_id=? AND semantic_version=? AND attempt_token=?`
        )
        .run(
          json(header),
          artifact.id,
          artifact.path,
          token,
          new Date().toISOString(),
          new Date().toISOString(),
          counts.total,
          counts.tables,
          runId,
          version,
          token
        );
    });
  }
  failSummaryAttempt(
    runId: string,
    version: string,
    token: string,
    status: "LEGACY" | "UNAVAILABLE",
    reason: string,
    retryable = false
  ): void {
    this.summaryTransaction(() => {
      this.assertSummaryAttempt(runId, version, token);
      this.client.db
        .prepare(
          "UPDATE run_comparison_summaries SET status=?,document=NULL,reason_code=?,retryable=?,lease_until=NULL,updated_at=? WHERE run_id=? AND semantic_version=? AND attempt_token=?"
        )
        .run(status, reason, retryable ? 1 : 0, new Date().toISOString(), runId, version, token);
    });
  }
  pageSummaryRows(
    runId: string,
    options: {
      version?: string;
      cursor?: string;
      limit?: number;
      tablesOnly?: boolean;
      nonTablesOnly?: boolean;
    } = {}
  ): RowPage {
    const version = options.version ?? METRIC_DEFINITIONS_VERSION,
      cache = this.getSummaryCache(runId, version);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("summary_page_limit_invalid");
    if (!cache || cache.status !== "READY")
      return { rows: [], hasMore: false, returnedRowCount: 0, totalRowCount: 0 };
    let offset = 0;
    const scope = options.tablesOnly ? "tables" : options.nonTablesOnly ? "non_tables" : "all";
    if (options.cursor) {
      let c: any;
      try {
        c = JSON.parse(Buffer.from(options.cursor, "base64url").toString());
      } catch {
        throw new Error("summary_cursor_invalid");
      }
      if (
        c.runId !== runId ||
        c.version !== version ||
        c.scope !== scope ||
        !Number.isSafeInteger(c.offset) ||
        c.offset < 0
      )
        throw new Error("summary_cursor_invalid");
      if (c.token !== cache.attemptToken) throw new Error("summary_cursor_stale");
      offset = c.offset;
    }
    const where = options.tablesOnly
      ? " AND table_name IS NOT NULL"
      : options.nonTablesOnly
        ? " AND table_name IS NULL"
        : "";
    const order = options.tablesOnly
      ? "table_name COLLATE BINARY,catalog_order,dimension_order,row_key"
      : "group_order,catalog_order,dimension_order,row_key";
    const values: any[] = this.client.db
      .prepare(
        `SELECT document FROM run_comparison_summary_rows WHERE run_id=? AND semantic_version=? AND attempt_token=? ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
      )
      .all(runId, version, cache.attemptToken, limit + 1, offset) as any[];
    const rows = values.slice(0, limit).map((x) => parse<SummaryRow>(x.document));
    rows.forEach(validateSummaryRow);
    const totalRowCount = options.tablesOnly
      ? cache.tableRowCount
      : options.nonTablesOnly
        ? cache.totalRowCount - cache.tableRowCount
        : cache.totalRowCount;
    const hasMore = offset + rows.length < totalRowCount;
    return {
      rows,
      hasMore,
      returnedRowCount: rows.length,
      totalRowCount,
      attemptToken: cache.attemptToken,
      semanticVersion: version,
      ...(hasMore
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                runId,
                version,
                token: cache.attemptToken,
                scope,
                offset: offset + rows.length
              })
            ).toString("base64url")
          }
        : {})
    };
  }
  countSummaryTableUnion(runId: string, baselineRunId?: string): number {
    const a = this.getSummaryCache(runId),
      b = baselineRunId ? this.getSummaryCache(baselineRunId) : undefined;
    const values = this.client.db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
      SELECT row_key FROM run_comparison_summary_rows WHERE run_id=? AND semantic_version=? AND attempt_token=? AND table_name IS NOT NULL
      UNION SELECT row_key FROM run_comparison_summary_rows WHERE run_id=? AND semantic_version=? AND attempt_token=? AND table_name IS NOT NULL
    )`
      )
      .get(
        a?.status === "READY" ? runId : "",
        METRIC_DEFINITIONS_VERSION,
        a?.attemptToken ?? "",
        b?.status === "READY" ? baselineRunId! : "",
        METRIC_DEFINITIONS_VERSION,
        b?.attemptToken ?? ""
      ) as any;
    return values.count;
  }
  findSummaryRow(
    runId: string,
    rowKey: string,
    version: string = METRIC_DEFINITIONS_VERSION
  ): SummaryRow | undefined {
    const row: any = this.client.db
      .prepare(
        `SELECT r.document FROM run_comparison_summary_rows r JOIN run_comparison_summaries c ON c.run_id=r.run_id AND c.semantic_version=r.semantic_version AND c.published_attempt_token=r.attempt_token WHERE c.status='READY' AND r.run_id=? AND r.semantic_version=? AND r.row_key=?`
      )
      .get(runId, version, rowKey);
    if (!row) return undefined;
    const value = parse<SummaryRow>(row.document);
    validateSummaryRow(value);
    return value;
  }
  async *iterateSummaryRows(
    runId: string,
    version: string = METRIC_DEFINITIONS_VERSION
  ): AsyncGenerator<SummaryRow> {
    let cursor: string | undefined;
    const cache = this.getSummaryCache(runId, version);
    if (cache?.status !== "READY") return;
    do {
      if (this.getSummaryCache(runId, version)?.attemptToken !== cache.attemptToken)
        throw new Error("summary_cursor_stale");
      const page = this.pageSummaryRows(runId, { version, cursor, limit: 64 });
      for (const row of page.rows) yield row;
      cursor = page.nextCursor;
    } while (cursor);
  }
  private summaryTransaction<T>(fn: () => T): T {
    this.client.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.client.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.client.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasNamedId(id: string): boolean {
    for (const table of [
      "experiments",
      "runs",
      "control_dashboard_contexts",
      "control_comparisons"
    ]) {
      try {
        if (this.client.db.prepare(`SELECT 1 FROM ${table} WHERE id=? LIMIT 1`).get(id))
          return true;
      } catch (error) {
        if (!String(error).includes("no such table")) throw error;
      }
    }
    return false;
  }
  saveEnvironment(environment: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.client.db
      .prepare(
        "INSERT OR REPLACE INTO environments(environment_id,run_id,state,document,created_at,updated_at) VALUES(?,?,?,?,COALESCE((SELECT created_at FROM environments WHERE environment_id=?),?),?)"
      )
      .run(
        String(environment.environmentId),
        String(environment.runId),
        String(environment.state),
        json(environment),
        String(environment.environmentId),
        String(environment.createdAt ?? now),
        now
      );
  }
  getEnvironment(environmentId: string): Record<string, unknown> | undefined {
    const row: any = this.client.db
      .prepare("SELECT document FROM environments WHERE environment_id=?")
      .get(environmentId);
    return row ? parse<Record<string, unknown>>(row.document) : undefined;
  }
  findEnvironmentsNeedingCleanup(): Array<Record<string, unknown>> {
    return (
      this.client.db
        .prepare(
          "SELECT document FROM environments WHERE state IN ('READY','FAILED','PROVISIONING') ORDER BY created_at"
        )
        .all() as any[]
    )
      .map((row) => parse<Record<string, unknown>>(row.document))
      .filter((record) => record.cleanupStatus !== "COMPLETE");
  }
  saveExperiment(experiment: Experiment): void {
    this.client.db
      .prepare("INSERT INTO experiments VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        experiment.id,
        experiment.scenario.id,
        experiment.scenario.version,
        experiment.comparisonMode,
        experiment.baselineVariantId ?? null,
        experiment.repetitions,
        json(experiment.inputs),
        experiment.status,
        experiment.createdAt,
        experiment.startedAt ?? null,
        experiment.finishedAt ?? null
      );
    for (const variant of experiment.variants)
      this.client.db
        .prepare("INSERT INTO variants VALUES(?,?,?,?,?)")
        .run(experiment.id, variant.id, variant.name, json(variant.parameters), json(variant));
  }
  getExperiment(id: string): Experiment | undefined {
    const row: any = this.client.db.prepare("SELECT * FROM experiments WHERE id=?").get(id);
    if (!row) return undefined;
    const variants = (
      this.client.db
        .prepare("SELECT * FROM variants WHERE experiment_id=? ORDER BY rowid")
        .all(id) as any[]
    ).map((v) => ({
      id: v.id,
      name: v.name,
      parameters: parse<Record<string, string | number | boolean>>(v.parameters)
    }));
    const runs = (
      this.client.db
        .prepare("SELECT id FROM runs WHERE experiment_id=? ORDER BY rowid")
        .all(id) as any[]
    ).map((r) => r.id);
    return {
      id: row.id,
      scenario: { id: row.scenario_id, version: row.scenario_version },
      comparisonMode: row.comparison_mode,
      baselineVariantId: row.baseline_variant_id ?? undefined,
      repetitions: row.repetitions,
      variants,
      inputs: parse(row.inputs),
      status: row.status,
      runIds: runs,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined
    };
  }
  listExperiments(): Experiment[] {
    return (
      this.client.db.prepare("SELECT id FROM experiments ORDER BY created_at DESC").all() as any[]
    )
      .map((row) => this.getExperiment(row.id))
      .filter((experiment): experiment is Experiment => Boolean(experiment));
  }
  updateExperimentStatus(
    id: string,
    status: string,
    finishedAt?: string,
    startedAt?: string
  ): void {
    this.client.db
      .prepare(
        "UPDATE experiments SET status=?, started_at=COALESCE(?,started_at), finished_at=COALESCE(?,finished_at) WHERE id=?"
      )
      .run(status, startedAt ?? null, finishedAt ?? null, id);
  }
  saveRun(run: Run): void {
    const environmentSnapshot = run.imageSnapshots
      ? { ...(run.environmentSnapshot ?? {}), imageSnapshots: run.imageSnapshots }
      : run.environmentSnapshot;
    this.client.db
      .prepare(
        "INSERT INTO runs(id,experiment_id,variant_id,repetition,state,measurement_validity,compose_project,resource_namespace,environment_snapshot,phase,started_at,measuring_at,finished_at,failure_kind,failure_reason,failure_code,completeness,cleanup_status,summary,observer_health,phase_boundaries) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET experiment_id=excluded.experiment_id,variant_id=excluded.variant_id,repetition=excluded.repetition,state=excluded.state,measurement_validity=excluded.measurement_validity,compose_project=excluded.compose_project,resource_namespace=excluded.resource_namespace,environment_snapshot=excluded.environment_snapshot,phase=excluded.phase,started_at=excluded.started_at,measuring_at=excluded.measuring_at,finished_at=excluded.finished_at,failure_kind=excluded.failure_kind,failure_reason=excluded.failure_reason,failure_code=excluded.failure_code,completeness=excluded.completeness,cleanup_status=excluded.cleanup_status,summary=excluded.summary,observer_health=excluded.observer_health,phase_boundaries=excluded.phase_boundaries"
      )
      .run(
        run.id,
        run.experimentId,
        run.variantId,
        run.repetition,
        run.state,
        run.measurementValidity,
        run.composeProject,
        json(run.resourceNamespace),
        json(environmentSnapshot),
        run.phase ?? null,
        run.startedAt ?? null,
        run.measuringAt ?? null,
        run.finishedAt ?? null,
        run.failureKind ?? null,
        run.failureReason ?? null,
        run.failureCode ?? null,
        json(run.completeness),
        run.cleanupStatus,
        json(run.summary),
        json(run.observerHealth),
        json(run.phaseBoundaries)
      );
  }
  getRun(id: string): Run | undefined {
    const row: any = this.client.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    return row ? this.rowToRun(row) : undefined;
  }
  listRuns(experimentId: string): Run[] {
    return (
      this.client.db
        .prepare("SELECT * FROM runs WHERE experiment_id=? ORDER BY rowid")
        .all(experimentId) as any[]
    ).map((row) => this.rowToRun(row));
  }
  listAllRuns(): Run[] {
    return (this.client.db.prepare("SELECT * FROM runs ORDER BY rowid DESC").all() as any[]).map(
      (row) => this.rowToRun(row)
    );
  }
  private rowToRun(row: any): Run {
    const environmentSnapshot = parse(row.environment_snapshot) as
      Record<string, unknown> | undefined;
    return {
      id: row.id,
      name:
        typeof environmentSnapshot?.runName === "string" ? environmentSnapshot.runName : undefined,
      experimentId: row.experiment_id,
      variantId: row.variant_id,
      repetition: row.repetition,
      state: row.state,
      measurementValidity: row.measurement_validity,
      composeProject: row.compose_project,
      resourceNamespace: parse(row.resource_namespace),
      environmentSnapshot,
      imageSnapshots: environmentSnapshot?.imageSnapshots as Run["imageSnapshots"],
      phase: row.phase ?? undefined,
      startedAt: row.started_at ?? undefined,
      measuringAt: row.measuring_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      failureKind: row.failure_kind ?? undefined,
      failureCode: row.failure_code ?? undefined,
      failureReason: row.failure_reason ?? undefined,
      completeness: parse(row.completeness),
      cleanupStatus: row.cleanup_status,
      summary: parse(row.summary),
      observerHealth: parse(row.observer_health),
      phaseBoundaries: parse(row.phase_boundaries)
    };
  }
  getIdempotency(
    operation: string,
    key: string
  ): { statusCode: number; response: unknown } | undefined {
    const row: any = this.client.db
      .prepare(
        "SELECT status_code,response FROM idempotency_keys WHERE operation=? AND idempotency_key=?"
      )
      .get(operation, key);
    return row ? { statusCode: row.status_code, response: parse(row.response) } : undefined;
  }
  saveIdempotency(operation: string, key: string, statusCode: number, response: unknown): void {
    this.client.db
      .prepare(
        "INSERT OR REPLACE INTO idempotency_keys(operation,idempotency_key,status_code,response,created_at) VALUES(?,?,?,?,?)"
      )
      .run(operation, key, statusCode, json(response), new Date().toISOString());
  }
  saveEvent(event: Omit<LifecycleEvent, "id">): LifecycleEvent {
    const result: any = this.client.db
      .prepare(
        "INSERT INTO lifecycle_events(run_id,from_state,to_state,occurred_at,actor,reason,details) VALUES(?,?,?,?,?,?,?)"
      )
      .run(
        event.runId,
        event.fromState,
        event.toState,
        event.occurredAt,
        event.actor,
        event.reason,
        json(event.details)
      );
    return { ...event, id: Number(result.lastInsertRowid) };
  }
  listEvents(runId: string, after = 0): LifecycleEvent[] {
    return (
      this.client.db
        .prepare("SELECT * FROM lifecycle_events WHERE run_id=? AND id>? ORDER BY id")
        .all(runId, after) as any[]
    ).map((row) => ({
      id: row.id,
      runId: row.run_id,
      fromState: row.from_state,
      toState: row.to_state,
      occurredAt: row.occurred_at,
      actor: row.actor,
      reason: row.reason,
      details: parse(row.details)
    }));
  }
  saveArtifact(artifact: Artifact): void {
    this.client.db
      .prepare(
        "INSERT OR REPLACE INTO artifacts (id,run_id,kind,path,size_bytes,format,source_metadata,created_at,retained) VALUES(?,?,?,?,?,?,?,?,?)"
      )
      .run(
        artifact.id,
        artifact.runId,
        artifact.kind,
        artifact.path,
        artifact.sizeBytes,
        artifact.format,
        json(artifact.sourceMetadata),
        artifact.createdAt,
        artifact.retained ? 1 : 0
      );
  }
  listArtifacts(runId: string): Artifact[] {
    return (
      this.client.db
        .prepare("SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at")
        .all(runId) as any[]
    ).map((row) => ({
      id: row.id,
      runId: row.run_id,
      kind: row.kind,
      path: row.path,
      sizeBytes: row.size_bytes,
      format: row.format,
      sourceMetadata: parse(row.source_metadata),
      createdAt: row.created_at,
      retained: Boolean(row.retained)
    }));
  }
  saveResource(
    runId: string,
    resource: {
      resourceType: string;
      resourceId: string;
      labels: Record<string, string>;
      createdAt: string;
      deletedAt?: string;
      cleanupResult?: string;
    }
  ): void {
    this.client.db
      .prepare(
        "INSERT OR REPLACE INTO resources(run_id,resource_type,resource_id,ownership_labels,created_at,deleted_at,cleanup_result) VALUES(?,?,?,?,?,?,?)"
      )
      .run(
        runId,
        resource.resourceType,
        resource.resourceId,
        json(resource.labels),
        resource.createdAt,
        resource.deletedAt ?? null,
        resource.cleanupResult ?? null
      );
  }
  listResources(runId: string): Array<Record<string, unknown>> {
    return (
      this.client.db
        .prepare("SELECT * FROM resources WHERE run_id=? ORDER BY created_at")
        .all(runId) as any[]
    ).map((row) => ({
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      labels: parse(row.ownership_labels),
      createdAt: row.created_at,
      deletedAt: row.deleted_at ?? undefined,
      cleanupResult: row.cleanup_result ?? undefined
    }));
  }
  findNonterminalRuns(): Run[] {
    return (
      this.client.db
        .prepare(
          "SELECT * FROM runs WHERE state NOT IN ('SUCCEEDED','INCOMPLETE','THRESHOLD_FAILED','FAILED','CANCELLED','INTERRUPTED')"
        )
        .all() as any[]
    ).map((row) => this.rowToRun(row));
  }
  findRunsNeedingCleanup(): Run[] {
    return (
      this.client.db
        .prepare(
          "SELECT * FROM runs WHERE cleanup_status <> 'COMPLETE' AND state IN ('SUCCEEDED','INCOMPLETE','THRESHOLD_FAILED','FAILED','CANCELLED','INTERRUPTED')"
        )
        .all() as any[]
    ).map((row) => this.rowToRun(row));
  }
}
