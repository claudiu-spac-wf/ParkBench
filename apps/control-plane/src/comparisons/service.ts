import { DATABASE_LATENCY_PARAMETER } from "../../../../packages/contracts/src/run-parameters";
import { Repositories } from "../db/repositories";
import {
  ComparisonSelection,
  ComparisonResult,
  SummaryReader,
  SummaryScheduler,
  SelectionPage,
  ComparisonRunResult,
  ComparisonTablePage
} from "../../../../packages/contracts/src/comparison";
import { SummaryRow } from "../../../../packages/contracts/src/run-summary";
import { Run } from "../../../../packages/contracts/src/run";
import { compareSummaryRow, missingCounterpart } from "./comparison-service";
export const COMPARISON_RESPONSE_BYTES = 8 * 1024 * 1024;
export function normalizeComparisonSelection(
  input: Partial<ComparisonSelection> & { id: string; variantRunIds: string[]; createdAt: string }
): ComparisonSelection {
  if (
    !Array.isArray(input.variantRunIds) ||
    input.variantRunIds.some((id) => typeof id !== "string" || !id || id.length > 256) ||
    (input.baselineRunId !== undefined &&
      (typeof input.baselineRunId !== "string" ||
        !input.baselineRunId ||
        input.baselineRunId.length > 256))
  )
    throw new Error("comparison_selection_invalid");
  const variantRunIds = [...new Set(input.variantRunIds)].filter(
    (id) => id !== input.baselineRunId
  );
  if (!input.baselineRunId && !variantRunIds.length) throw new Error("comparison_selection_empty");
  return {
    ...input,
    variantRunIds,
    selectionRevision: input.selectionRevision ?? 1
  } as ComparisonSelection;
}
export function selectedRunIds(selection: ComparisonSelection): string[] {
  return [
    ...(selection.baselineRunId ? [selection.baselineRunId] : []),
    ...selection.variantRunIds
  ];
}
export function encodeComparisonCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeComparisonCursor(
  cursor: string | undefined,
  selection: ComparisonSelection,
  kind: "selection" | "runs"
): number {
  if (!cursor) return 0;
  let value: any;
  try {
    if (cursor.length > 2048) throw new Error();
    value = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    throw new Error(`comparison_${kind === "selection" ? "selection" : "run"}_cursor_invalid`);
  }
  const prefix = kind === "selection" ? "comparison_selection_cursor" : "comparison_run_cursor";
  if (
    value.id !== selection.id ||
    value.kind !== kind ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0
  )
    throw new Error(prefix + "_invalid");
  if (value.revision !== (selection.selectionRevision ?? 1)) throw new Error(prefix + "_stale");
  return value.offset;
}
export function pageLimit(value: unknown, defaultValue: number, max: number): number {
  if (value === undefined) return defaultValue;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max)
    throw new Error("comparison_page_limit_invalid");
  return limit;
}
export function comparisonSelectionPage(
  selection: ComparisonSelection,
  options: { cursor?: string; limit?: number } = {}
): SelectionPage {
  const ids = selectedRunIds(selection),
    offset = decodeComparisonCursor(options.cursor, selection, "selection"),
    limit = pageLimit(options.limit, 100, 500);
  const runIds = ids.slice(offset, offset + limit),
    hasMore = offset + runIds.length < ids.length;
  return {
    runIds,
    hasMore,
    returnedRunCount: runIds.length,
    totalSelectedRunCount: ids.length,
    ...(hasMore
      ? {
          nextCursor: encodeComparisonCursor({
            id: selection.id,
            kind: "selection",
            revision: selection.selectionRevision ?? 1,
            offset: offset + runIds.length
          })
        }
      : {})
  };
}
export function buildComparison(
  selection: ComparisonSelection,
  reader: SummaryReader,
  lookup: (id: string) => Run | undefined,
  options: {
    cursor?: string;
    limit?: number;
    scheduler?: SummaryScheduler;
    scenario?: (run: Run) => ComparisonRunResult["scenario"];
  } = {}
): ComparisonResult {
  const ids = selectedRunIds(selection),
    offset = decodeComparisonCursor(options.cursor, selection, "runs"),
    limit = pageLimit(options.limit, 5, 25),
    baseline = selection.baselineRunId ? reader.read(selection.baselineRunId) : undefined;
  const result: ComparisonResult = {
    contractVersion: "comparison.v2",
    id: selection.id,
    experimentId: selection.experimentId,
    baselineRunId: selection.baselineRunId,
    selectionRevision: selection.selectionRevision ?? 1,
    totalSelectedRunCount: ids.length,
    selectionEndpoint: `/api/v1/comparisons/${encodeURIComponent(selection.id)}/selection`,
    selectionPage: comparisonSelectionPage(selection),
    dashboardContextId: selection.dashboardContextId,
    createdAt: selection.createdAt,
    runs: [],
    warnings: [],
    page: { hasMore: false, returnedRunCount: 0, totalSelectedRunCount: ids.length }
  };
  const scenarios = new Map<string, { versions: Set<string>; fingerprints: Set<string> }>();
  for (const id of ids) {
    const run = lookup(id);
    if (!run) throw new Error("comparison_run_not_found");
    const scenario = options.scenario?.(run) ?? recordedScenario(run);
    if (!scenario) continue;
    const identity = scenarios.get(scenario.id) ?? {
      versions: new Set<string>(),
      fingerprints: new Set<string>()
    };
    if (scenario.version) identity.versions.add(scenario.version);
    if (scenario.fingerprint) identity.fingerprints.add(scenario.fingerprint);
    scenarios.set(scenario.id, identity);
  }
  if (
    scenarios.size > 1 ||
    [...scenarios.values()].some(
      (identity) => identity.versions.size > 1 || identity.fingerprints.size > 1
    )
  )
    result.warnings.push({
      code: "different_scenarios",
      message:
        "Selected runs use different scenarios. Interpret this comparison with that difference in mind."
    });
  for (const runId of ids.slice(offset, offset + limit)) {
    const run = lookup(runId);
    if (!run) throw new Error("comparison_run_not_found");
    const summary = reader.read(runId);
    if (summary.status === "RECOMPUTING") result.retryAfterSeconds = 2;
    const role = runId === selection.baselineRunId ? "BASELINE" : "VARIANT";
    const resource =
      summary.status === "READY"
        ? reader.page(runId, { limit: 500, nonTablesOnly: true })
        : { rows: [] };
    const table = comparisonTablePage(selection, runId, reader, { limit: 100 });
    const rows = [
      ...resource.rows.map((row) =>
        compareSummaryRow(
          row,
          selection.baselineRunId ? reader.find(selection.baselineRunId, row.rowKey) : undefined,
          summary.header,
          baseline?.header,
          role === "BASELINE"
        )
      ),
      ...table.rows
    ];
    const item: ComparisonRunResult = {
      runId,
      experimentId: run.experimentId,
      scenario: options.scenario?.(run) ?? recordedScenario(run),
      name: run.name,
      role,
      state: run.state,
      measurementValidity: run.measurementValidity,
      summary,
      rows,
      tablePage: {
        nextCursor: table.nextCursor,
        hasMore: !!table.hasMore,
        totalRowCount: table.totalRowCount ?? 0,
        returnedRowCount: table.returnedRowCount ?? 0
      },
      context: {
        // Runs recorded before Database Latency existed ran with latency 0.
        effectiveConfiguration: {
          [DATABASE_LATENCY_PARAMETER]: 0,
          ...((run.environmentSnapshot as any)?.effectiveConfiguration ?? {})
        },
        databaseRunControls: (run.environmentSnapshot as any)?.databaseRunControls,
        databaseLatency: compactLatency((run.environmentSnapshot as any)?.databaseLatency),
        phaseBoundaries: run.phaseBoundaries,
        cleanupStatus: run.cleanupStatus,
        failureReason: run.failureReason,
        inputReferences: (run.environmentSnapshot as any)?.inputs ?? {}
      }
    };
    result.runs.push(item);
    if (Buffer.byteLength(JSON.stringify(result)) > COMPARISON_RESPONSE_BYTES) {
      result.runs.pop();
      if (!result.runs.length) throw new Error("summary_limit_exceeded:comparison_header");
      break;
    }
  }
  const next = offset + result.runs.length;
  result.page = {
    hasMore: next < ids.length,
    returnedRunCount: result.runs.length,
    totalSelectedRunCount: ids.length,
    ...(next < ids.length
      ? {
          nextCursor: encodeComparisonCursor({
            id: selection.id,
            kind: "runs",
            revision: selection.selectionRevision ?? 1,
            offset: next
          })
        }
      : {})
  };
  return result;
}
export function recordedScenario(run: Run): ComparisonRunResult["scenario"] {
  const scenario = (run.environmentSnapshot as any)?.scenario;
  return typeof scenario?.id === "string"
    ? {
        id: scenario.id,
        ...(typeof scenario.version === "string" ? { version: scenario.version } : {}),
        ...(typeof scenario.fingerprint === "string" ? { fingerprint: scenario.fingerprint } : {})
      }
    : undefined;
}
/** Experiment callers delegate to one exact selection instead of averaging repetitions. */
export function comparison(
  repositories: Repositories,
  experimentId: string
): Record<string, unknown> {
  const experiment = repositories.getExperiment(experimentId);
  if (!experiment) throw new Error("experiment_not_found");
  const runs = repositories.listRuns(experimentId),
    baseline = runs.find((r) => r.variantId === experiment.baselineVariantId);
  if (!runs.length) throw new Error("comparison_selection_empty");
  const selection = normalizeComparisonSelection({
    id: experimentId,
    experimentId,
    baselineRunId: baseline?.id,
    variantRunIds: runs.map((r) => r.id),
    createdAt: experiment.createdAt
  });
  return buildComparison(
    selection,
    {
      read: (id) =>
        repositories.getSummaryCache(id) ?? { status: "LEGACY", reason: "legacy_semantics" },
      page: (id, o) => repositories.pageSummaryRows(id, o),
      find: (id, key) => repositories.findSummaryRow(id, key),
      iterate: (id) => repositories.iterateSummaryRows(id)
    },
    (id) => repositories.getRun(id)
  ) as unknown as Record<string, unknown>;
}

function tableOrder(row: SummaryRow): (string | number)[] {
  return [
    row.dimensions.table ?? "",
    row.catalogOrder ?? 0,
    JSON.stringify(Object.entries(row.dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    row.rowKey
  ];
}
function compareTableOrder(a: SummaryRow, b: SummaryRow): number {
  const left = tableOrder(a),
    right = tableOrder(b);
  for (let i = 0; i < left.length; i++)
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
/** Bounded merge of published indexes; neither side's missing keys become zero. */
export function comparisonTablePage(
  selection: ComparisonSelection,
  runId: string,
  reader: SummaryReader,
  options: { cursor?: string; limit?: number } = {}
): ComparisonTablePage {
  if (runId !== selection.baselineRunId && !selection.variantRunIds.includes(runId))
    throw new Error("comparison_run_not_selected");
  const a = reader.read(runId),
    baselineId = selection.baselineRunId === runId ? undefined : selection.baselineRunId,
    b = baselineId ? reader.read(baselineId) : undefined,
    limit = pageLimit(options.limit, 100, 500);
  const identity = {
    id: selection.id,
    runId,
    revision: selection.selectionRevision ?? 1,
    token: a.attemptToken ?? null,
    baselineId: baselineId ?? null,
    baselineToken: b?.attemptToken ?? null,
    version: a.header?.metricDefinitionsVersion ?? null,
    baselineVersion: b?.header?.metricDefinitionsVersion ?? null
  };
  let state: any = {
    ...identity,
    aCursor: undefined,
    bCursor: undefined,
    aDone: a.status !== "READY",
    bDone: b?.status !== "READY",
    offset: 0
  };
  if (options.cursor) {
    try {
      if (options.cursor.length > 8192) throw new Error();
      const cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString());
      for (const [key, value] of Object.entries(identity))
        if (cursor[key] !== value) throw new Error();
      if (
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        typeof cursor.aDone !== "boolean" ||
        typeof cursor.bDone !== "boolean" ||
        [cursor.aCursor, cursor.bCursor].some((v) => v !== undefined && typeof v !== "string")
      )
        throw new Error();
      state = cursor;
    } catch {
      throw new Error("comparison_table_cursor_stale");
    }
  }
  const result: ComparisonTablePage = {
    id: selection.id,
    runId,
    selectionRevision: identity.revision,
    rows: [],
    hasMore: false,
    returnedRowCount: 0,
    totalRowCount: reader.tableUnionCount?.(runId, baselineId) ?? 0,
    attemptToken: a.attemptToken,
    baselineAttemptToken: b?.attemptToken
  };
  const peek = (id: string | undefined, cursor: string | undefined, done: boolean) =>
    !id || done ? undefined : reader.page(id, { cursor, limit: 1, tablesOnly: true });
  while (result.rows.length < limit) {
    const pa = peek(runId, state.aCursor, state.aDone),
      pb = peek(baselineId, state.bCursor, state.bDone),
      ra = pa?.rows[0],
      rb = pb?.rows[0];
    if (!ra) state.aDone = true;
    if (!rb) state.bDone = true;
    if (!ra && !rb) break;
    const order = ra && rb ? compareTableOrder(ra, rb) : ra ? -1 : 1,
      primary =
        order <= 0
          ? ra!
          : missingCounterpart(
              rb!,
              a.header?.windows.measurement.durationSeconds ?? rb!.coverage.durationSeconds
            ),
      baselineRow =
        order === 0 ? rb : baselineId ? reader.find(baselineId, primary.rowKey) : undefined;
    const row = compareSummaryRow(
      primary,
      baselineRow,
      a.header,
      b?.header,
      runId === selection.baselineRunId
    );
    result.rows.push(row);
    if (Buffer.byteLength(JSON.stringify(result)) > COMPARISON_RESPONSE_BYTES) {
      result.rows.pop();
      if (!result.rows.length) throw new Error("summary_limit_exceeded:comparison_table_row");
      break;
    }
    if (order <= 0) {
      state.aCursor = pa?.nextCursor;
      state.aDone = !pa?.hasMore;
    }
    if (order >= 0) {
      state.bCursor = pb?.nextCursor;
      state.bDone = !pb?.hasMore;
    }
    state.offset++;
  }
  result.returnedRowCount = result.rows.length;
  result.hasMore = !state.aDone || !state.bDone;
  if (!reader.tableUnionCount) {
    // Injected readers may count using bounded pages; production uses one indexed SQL count.
    let count = 0,
      leftCursor: string | undefined,
      rightCursor: string | undefined,
      leftDone = a.status !== "READY",
      rightDone = b?.status !== "READY";
    while (!leftDone || !rightDone) {
      const pa = peek(runId, leftCursor, leftDone),
        pb = peek(baselineId, rightCursor, rightDone),
        ra = pa?.rows[0],
        rb = pb?.rows[0];
      if (!ra) leftDone = true;
      if (!rb) rightDone = true;
      if (!ra && !rb) break;
      const order = ra && rb ? compareTableOrder(ra, rb) : ra ? -1 : 1;
      if (order <= 0) {
        leftCursor = pa?.nextCursor;
        leftDone = !pa?.hasMore;
      }
      if (order >= 0) {
        rightCursor = pb?.nextCursor;
        rightDone = !pb?.hasMore;
      }
      count++;
    }
    result.totalRowCount = count;
  }
  if (result.hasMore) result.nextCursor = encodeComparisonCursor(state);
  // A concurrent replacement never returns mixed published attempts.
  if (
    reader.read(runId).attemptToken !== a.attemptToken ||
    (baselineId && reader.read(baselineId).attemptToken !== b?.attemptToken)
  )
    throw new Error("comparison_table_cursor_stale");
  return result;
}

/** Latency evidence without the raw tc output, which can be long, for comparison headers. */
function compactLatency(evidence: any): Record<string, unknown> | undefined {
  if (!evidence) return undefined;
  const { requestedMs, appliedMs, mode, status, failureCode, probe } = evidence;
  return { requestedMs, appliedMs, mode, status, failureCode, probe };
}
