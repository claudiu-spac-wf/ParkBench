import { Repositories } from "../db/repositories";
import type { SummaryReader } from "../../../../packages/contracts/src/comparison";
import { DatabaseClient } from "../db/client";
import type { CatalogAction } from "../../../../packages/contracts/src/catalog";
import {
  ComparisonView,
  ControlExperimentView,
  ControlRunView,
  DashboardContext,
  ImageOperation,
  MatrixCell,
  MatrixPreviewRequest
} from "../../../../packages/contracts/src";

const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T>(value: unknown): T =>
  (typeof value === "string" ? JSON.parse(value) : value) as T;

export class ControlUiRepository {
  constructor(private readonly database: DatabaseClient) {}

  summaryReader(): SummaryReader {
    const r = new Repositories(this.database);
    return {
      tableUnionCount: (a, b) => r.countSummaryTableUnion(a, b),
      read: (runId) =>
        r.getSummaryCache(runId) ?? { status: "UNAVAILABLE", reason: "not_collected" },
      page: (runId, options) => r.pageSummaryRows(runId, options),
      find: (runId, key) => r.findSummaryRow(runId, key),
      iterate: (runId) => r.iterateSummaryRows(runId)
    };
  }
  saveCatalogAction(action: CatalogAction): void {
    this.database.db
      .prepare(
        `INSERT INTO control_catalog_actions(id,kind,state,document,created_at,finished_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,
      document=excluded.document,finished_at=excluded.finished_at`
      )
      .run(
        action.id,
        action.kind,
        action.state,
        json(action),
        action.createdAt,
        action.finishedAt ?? null
      );
  }

  getCatalogAction(id: string): CatalogAction | undefined {
    const row = this.database.db
      .prepare("SELECT document FROM control_catalog_actions WHERE id=?")
      .get(id) as any;
    return row ? parse<CatalogAction>(row.document) : undefined;
  }

  listCatalogActions(kind?: string): CatalogAction[] {
    const rows = (
      kind
        ? this.database.db
            .prepare(
              "SELECT document FROM control_catalog_actions WHERE kind=? ORDER BY created_at DESC"
            )
            .all(kind)
        : this.database.db
            .prepare("SELECT document FROM control_catalog_actions ORDER BY created_at DESC")
            .all()
    ) as any[];
    return rows.map((row) => parse<CatalogAction>(row.document));
  }

  saveOperation(operation: ImageOperation): void {
    this.database.db
      .prepare(
        `
      INSERT OR REPLACE INTO control_image_operations
      (id,kind,stage,input_asset_ids,expected_contracts,output_profile,command_id,state,progress,diagnostics,logs,output_asset_ids,failure_code,failure_reason,started_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        operation.id,
        operation.kind,
        operation.stage ?? null,
        json(operation.inputAssetIds),
        json(operation.expectedContracts),
        operation.outputProfile ?? null,
        operation.commandId,
        operation.state,
        json(operation.progress),
        json(operation.diagnostics),
        json(operation.logs ?? []),
        json(operation.outputAssetIds),
        operation.failureCode ?? null,
        operation.failureReason ?? null,
        operation.startedAt ?? null,
        operation.finishedAt ?? null
      );
  }

  getOperation(id: string): ImageOperation | undefined {
    const row: any = this.database.db
      .prepare("SELECT * FROM control_image_operations WHERE id=?")
      .get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      kind: row.kind,
      stage: row.stage ?? undefined,
      inputAssetIds: parse(row.input_asset_ids),
      expectedContracts: parse(row.expected_contracts),
      outputProfile: row.output_profile ?? undefined,
      commandId: row.command_id,
      state: row.state,
      progress: parse(row.progress),
      diagnostics: parse(row.diagnostics),
      logs: parse(row.logs ?? "[]"),
      outputAssetIds: parse(row.output_asset_ids),
      failureCode: row.failure_code ?? undefined,
      failureReason: row.failure_reason ?? undefined,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined
    };
  }

  getOperationByCommandId(commandId: string): ImageOperation | undefined {
    const row: any = this.database.db
      .prepare(
        "SELECT id FROM control_image_operations WHERE command_id=? ORDER BY rowid DESC LIMIT 1"
      )
      .get(commandId);
    return row ? this.getOperation(row.id) : undefined;
  }

  saveCommandResult(
    operation: string,
    idempotencyKey: string,
    statusCode: number,
    response: unknown
  ): void {
    this.database.db
      .prepare(
        `INSERT OR REPLACE INTO control_command_results
         (operation,idempotency_key,status_code,response,created_at)
         VALUES (?,?,?,?,?)`
      )
      .run(operation, idempotencyKey, statusCode, json(response), new Date().toISOString());
  }

  getCommandResult(
    operation: string,
    idempotencyKey: string
  ): { statusCode: number; response: unknown } | undefined {
    const row: any = this.database.db
      .prepare(
        "SELECT status_code,response FROM control_command_results WHERE operation=? AND idempotency_key=?"
      )
      .get(operation, idempotencyKey);
    return row ? { statusCode: row.status_code, response: parse(row.response) } : undefined;
  }

  savePreview(preview: {
    id: string;
    request: MatrixPreviewRequest;
    cells: MatrixCell[];
    cellCount: number;
    runCount: number;
    warning: Record<string, string>;
    expiresAt: string;
    state: string;
    reviewedRanges?: Array<[number, number]>;
  }): void {
    this.database.db
      .prepare(
        `
      INSERT OR REPLACE INTO control_previews
      (id,request_json,scenario_id,scenario_version,cells_json,cell_count,run_count,warning,expires_at,state,reviewed_ranges)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        preview.id,
        json(preview.request),
        preview.request.scenario.id,
        preview.request.scenario.version,
        json(preview.cells),
        preview.cellCount,
        preview.runCount,
        json(preview.warning),
        preview.expiresAt,
        preview.state,
        json(preview.reviewedRanges ?? [])
      );
  }

  markPreviewRangeReviewed(id: string, start: number, end: number): void {
    const preview = this.getPreview(id);
    if (!preview || end <= start) return;
    const ranges = [...preview.reviewedRanges, [start, end] as [number, number]]
      .sort(([left], [right]) => left - right)
      .reduce<Array<[number, number]>>((merged, range) => {
        const previous = merged.at(-1);
        if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
        else merged.push([...range] as [number, number]);
        return merged;
      }, []);
    this.database.db
      .prepare("UPDATE control_previews SET reviewed_ranges=? WHERE id=?")
      .run(json(ranges), id);
  }

  getPreview(id: string):
    | {
        id: string;
        request: MatrixPreviewRequest;
        cells: MatrixCell[];
        cellCount: number;
        runCount: number;
        warning: Record<string, string>;
        expiresAt: string;
        state: string;
        reviewedRanges: Array<[number, number]>;
      }
    | undefined {
    const row: any = this.database.db.prepare("SELECT * FROM control_previews WHERE id=?").get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      request: parse(row.request_json),
      cells: parse(row.cells_json),
      cellCount: row.cell_count,
      runCount: row.run_count,
      warning: parse(row.warning),
      expiresAt: row.expires_at,
      state: row.state,
      reviewedRanges: parse(row.reviewed_ranges ?? "[]")
    };
  }

  saveExperiment(record: {
    experimentId: string;
    previewId: string;
    request: unknown;
    scenarioSnapshot: unknown;
    matrixSpec: unknown;
    executionPolicy: unknown;
    queueOrdinal: number;
    baselineRunId?: string;
    status: string;
    createdAt: string;
  }): void {
    this.database.db
      .prepare(
        `
      INSERT OR REPLACE INTO control_experiments
      (experiment_id,preview_id,request_json,scenario_snapshot,matrix_spec,execution_policy,queue_ordinal,baseline_run_id,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        record.experimentId,
        record.previewId,
        json(record.request),
        json(record.scenarioSnapshot),
        json(record.matrixSpec),
        json(record.executionPolicy),
        record.queueOrdinal,
        record.baselineRunId ?? null,
        record.status,
        record.createdAt
      );
  }

  getControlExperiment(id: string): any | undefined {
    const row: any = this.database.db
      .prepare("SELECT * FROM control_experiments WHERE experiment_id=?")
      .get(id);
    if (!row) return undefined;
    return {
      id: row.experiment_id,
      previewId: row.preview_id,
      request: parse(row.request_json),
      scenarioSnapshot: parse(row.scenario_snapshot),
      matrixSpec: parse(row.matrix_spec),
      executionPolicy: parse(row.execution_policy),
      queueOrdinal: row.queue_ordinal,
      baselineRunId: row.baseline_run_id ?? undefined,
      status: row.status,
      createdAt: row.created_at
    };
  }

  listControlExperiments(): any[] {
    return (
      this.database.db
        .prepare("SELECT experiment_id FROM control_experiments ORDER BY queue_ordinal")
        .all() as any[]
    ).map((row) => this.getControlExperiment(row.experiment_id)!);
  }

  updateControlExperiment(id: string, fields: { status?: string; baselineRunId?: string }): void {
    const current = this.getControlExperiment(id);
    if (!current) return;
    this.saveExperiment({
      ...current,
      experimentId: id,
      scenarioSnapshot: current.scenarioSnapshot,
      matrixSpec: current.matrixSpec,
      executionPolicy: current.executionPolicy,
      request: current.request,
      previewId: current.previewId,
      queueOrdinal: current.queueOrdinal,
      createdAt: current.createdAt,
      status: fields.status ?? current.status,
      baselineRunId: fields.baselineRunId ?? current.baselineRunId
    });
  }

  saveRunMetadata(record: {
    runId: string;
    experimentId: string;
    cellOrdinal: number;
    repetition: number;
    values: unknown;
    effectiveConfiguration: unknown;
    snapshot: unknown;
    queueState: string;
    blockedReason?: string;
    nextRetryAt?: string;
    retryCount?: number;
    updatedAt: string;
  }): void {
    this.database.db
      .prepare(
        `
      INSERT OR REPLACE INTO control_run_metadata
      (run_id,experiment_id,cell_ordinal,repetition,values_json,effective_configuration,snapshot,queue_state,blocked_reason,next_retry_at,retry_count,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        record.runId,
        record.experimentId,
        record.cellOrdinal,
        record.repetition,
        json(record.values),
        json(record.effectiveConfiguration),
        json(record.snapshot),
        record.queueState,
        record.blockedReason ?? null,
        record.nextRetryAt ?? null,
        record.retryCount ?? 0,
        record.updatedAt
      );
  }

  getRunMetadata(runId: string): ControlRunView | undefined {
    const row: any = this.database.db
      .prepare("SELECT * FROM control_run_metadata WHERE run_id=?")
      .get(runId);
    return row ? this.runMetadataFromRow(row) : undefined;
  }

  listRunMetadata(experimentId?: string): ControlRunView[] {
    const rows = (
      experimentId
        ? this.database.db
            .prepare(
              "SELECT * FROM control_run_metadata WHERE experiment_id=? ORDER BY cell_ordinal,repetition"
            )
            .all(experimentId)
        : this.database.db
            .prepare(
              "SELECT * FROM control_run_metadata ORDER BY experiment_id,cell_ordinal,repetition"
            )
            .all()
    ) as any[];
    return rows.map((row) => this.runMetadataFromRow(row));
  }

  queryHistory(
    filters: Record<string, string | undefined>,
    offset = 0,
    limit = 50
  ): { runIds: string[]; hasMore: boolean } {
    const conditions = [
      "r.state IN ('SUCCEEDED','THRESHOLD_FAILED','FAILED','CANCELLED','INCOMPLETE','INTERRUPTED')"
    ];
    const parameters: Array<string | number> = [];
    if (filters.experiment) {
      conditions.push("e.experiment_id = ?");
      parameters.push(filters.experiment);
    }
    if (filters.status) {
      conditions.push("r.state = ?");
      parameters.push(filters.status);
    }
    if (filters.runId) {
      conditions.push("r.id = ?");
      parameters.push(filters.runId);
    }
    if (filters.scenario) {
      const [scenarioId, scenarioVersion] = filters.scenario.split("@", 2);
      conditions.push("json_extract(e.request_json, '$.scenario.id') = ?");
      parameters.push(scenarioId);
      if (scenarioVersion) {
        conditions.push("json_extract(e.request_json, '$.scenario.version') = ?");
        parameters.push(scenarioVersion);
      }
    }
    if (filters.workload) {
      conditions.push("e.scenario_snapshot LIKE ?");
      parameters.push(`%${filters.workload}%`);
    }
    if (filters.image) {
      conditions.push("e.request_json LIKE ?");
      parameters.push(`%${filters.image}%`);
    }
    if (filters.parameter) {
      conditions.push("m.effective_configuration LIKE ?");
      parameters.push(`%${filters.parameter}%`);
    }
    if (filters.repetition) {
      conditions.push("m.repetition = ?");
      parameters.push(Number(filters.repetition));
    }
    if (filters.from) {
      conditions.push("r.finished_at >= ?");
      parameters.push(filters.from);
    }
    if (filters.to) {
      conditions.push("r.finished_at <= ?");
      parameters.push(filters.to);
    }
    const rows = this.database.db
      .prepare(
        `SELECT m.run_id
         FROM control_run_metadata m
         JOIN runs r ON r.id = m.run_id
         JOIN control_experiments e ON e.experiment_id = m.experiment_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY COALESCE(r.finished_at, r.started_at, e.created_at) DESC, m.run_id
         LIMIT ? OFFSET ?`
      )
      .all(...parameters, Math.max(1, limit) + 1, Math.max(0, offset)) as Array<{ run_id: string }>;
    return {
      runIds: rows.slice(0, limit).map((row) => row.run_id),
      hasMore: rows.length > limit
    };
  }

  private runMetadataFromRow(row: any): ControlRunView {
    const snapshot = parse(row.snapshot) as Record<string, unknown>;
    return {
      id: row.run_id,
      name: typeof snapshot?.runName === "string" ? snapshot.runName : undefined,
      queuedAt: typeof snapshot?.queuedAt === "string" ? snapshot.queuedAt : undefined,
      experimentId: row.experiment_id,
      cellOrdinal: row.cell_ordinal,
      repetition: row.repetition,
      values: parse(row.values_json),
      effectiveConfiguration: parse(row.effective_configuration),
      state: row.queue_state,
      queueState: row.queue_state,
      blockedReason: row.blocked_reason ?? undefined,
      nextRetryAt: row.next_retry_at ?? undefined,
      retryCount: row.retry_count,
      snapshot,
      updatedAt: row.updated_at
    };
  }

  saveComparison(comparison: ComparisonView): void {
    const previous = this.getComparison(comparison.id);
    comparison.selectionRevision = previous
      ? (previous.selectionRevision ?? 1) +
        (previous.baselineRunId !== comparison.baselineRunId ||
        JSON.stringify(previous.variantRunIds) !== JSON.stringify(comparison.variantRunIds)
          ? 1
          : 0)
      : (comparison.selectionRevision ?? 1);
    this.database.db
      .prepare(
        `
      INSERT INTO control_comparisons
      (id,experiment_id,baseline_run_id,variant_run_ids,eligibility,eligibility_reasons,shared_context,dashboard_context_id,created_at,selection_revision)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET experiment_id=excluded.experiment_id,baseline_run_id=excluded.baseline_run_id,variant_run_ids=excluded.variant_run_ids,eligibility=excluded.eligibility,eligibility_reasons=excluded.eligibility_reasons,shared_context=excluded.shared_context,dashboard_context_id=excluded.dashboard_context_id,selection_revision=excluded.selection_revision
    `
      )
      .run(
        comparison.id,
        comparison.experimentId ?? null,
        comparison.baselineRunId ?? null,
        json(comparison.variantRunIds),
        comparison.eligibility,
        json(comparison.eligibilityReasons),
        json(comparison.sharedContext),
        comparison.dashboardContextId ?? null,
        comparison.createdAt,
        comparison.selectionRevision
      );
  }

  getComparison(id: string): ComparisonView | undefined {
    const row: any = this.database.db
      .prepare("SELECT * FROM control_comparisons WHERE id=?")
      .get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      experimentId: row.experiment_id ?? undefined,
      baselineRunId: row.baseline_run_id ?? undefined,
      variantRunIds: parse(row.variant_run_ids),
      selectionRevision: row.selection_revision ?? 1,
      eligibility: row.eligibility,
      eligibilityReasons: parse(row.eligibility_reasons),
      sharedContext: parse(row.shared_context),
      dashboardContextId: row.dashboard_context_id ?? undefined,
      runs: [],
      createdAt: row.created_at
    };
  }

  latestComparisonForExperiment(id: string): ComparisonView | undefined {
    const row: any = this.database.db
      .prepare(
        "SELECT id FROM control_comparisons WHERE experiment_id=? ORDER BY rowid DESC LIMIT 1"
      )
      .get(id);
    return row ? this.getComparison(row.id) : undefined;
  }
  saveDashboard(context: DashboardContext): void {
    this.database.db
      .prepare(
        `
      INSERT INTO control_dashboard_contexts
      (id,experiment_id,run_ids,baseline_run_id,phase,metric_scope,dashboard_refs,variables,availability,grafana_url,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        context.id,
        context.experimentId ?? null,
        json(context.runIds),
        context.baselineRunId ?? null,
        context.phase ?? null,
        json(context.metricScope),
        json(context.dashboardRefs),
        json(context.variables),
        context.availability,
        context.grafanaUrl ?? null,
        context.expiresAt
      );
  }

  updateDashboardPresentation(context: DashboardContext): void {
    this.database.db
      .prepare(
        "UPDATE control_dashboard_contexts SET availability=?,grafana_url=?,expires_at=? WHERE id=?"
      )
      .run(context.availability, context.grafanaUrl ?? null, context.expiresAt, context.id);
  }

  getDashboard(id: string): DashboardContext | undefined {
    const row: any = this.database.db
      .prepare("SELECT * FROM control_dashboard_contexts WHERE id=?")
      .get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      experimentId: row.experiment_id ?? undefined,
      runIds: parse(row.run_ids),
      baselineRunId: row.baseline_run_id ?? undefined,
      phase: row.phase ?? undefined,
      metricScope: parse(row.metric_scope),
      dashboardRefs: parse(row.dashboard_refs),
      variables: parse(row.variables),
      availability: row.availability,
      grafanaUrl: row.grafana_url ?? undefined,
      expiresAt: row.expires_at
    };
  }

  listDashboards(): DashboardContext[] {
    return (
      this.database.db
        .prepare("SELECT id FROM control_dashboard_contexts ORDER BY rowid")
        .all() as any[]
    )
      .map((row) => this.getDashboard(row.id))
      .filter((context): context is DashboardContext => Boolean(context));
  }
}
