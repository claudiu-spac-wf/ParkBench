import { TableRankSelector } from "./table-ranking";
import type { SummaryReader } from "../../../../packages/contracts/src/comparison";
/** Paged read-only view of the same persisted statistics used by UI/API/CSV. */
export class SavedSummaryQueries {
  constructor(
    private readonly reader: SummaryReader,
    private readonly schedule?: (runId: string) => void
  ) {}
  async query(runId: string, labels: Map<string, string>, time: number): Promise<any[]> {
    let state = this.reader.read(runId);
    if (state.status !== "READY") {
      this.schedule?.(runId);
      state = this.reader.read(runId);
      return [
        {
          metric: {
            run_id: runId,
            summary_state: state.status,
            reason: state.reason ?? "",
            entry_kind: "status"
          },
          value: [time / 1000, "NaN"]
        }
      ];
    }
    if (labels.get("ranking") === "top10") return this.ranked(runId, labels, time);
    const token = state.attemptToken;
    const filter = labels.get("scope") ?? "resource";
    const page = this.reader.page(runId, {
      limit: Math.min(500, Math.max(1, Number(labels.get("limit") ?? 100))),
      tablesOnly: filter === "table_covered",
      nonTablesOnly: filter !== "table_covered",
      cursor: labels.get("cursor") || undefined
    });
    const rows = page.rows.filter(
      (r) =>
        r.coverageScope === filter &&
        (!labels.get("group") || r.group === labels.get("group")) &&
        (!labels.get("definition") || r.definitionId === labels.get("definition"))
    );
    const result: any[] = [];
    for (const row of rows)
      for (const [statistic, stat] of Object.entries(row.statistics))
        result.push({
          metric: {
            run_id: runId,
            definition: row.definitionId,
            group: row.group,
            scope: row.coverageScope,
            ...row.dimensions,
            statistic,
            unit: stat.unit,
            status: stat.status,
            reason: stat.reasons.join("; "),
            observed_seconds: String(row.coverage.observedSeconds),
            missing_seconds: String(row.coverage.missingSeconds),
            window_start: state.header?.windows.measurement.start ?? "",
            window_end: state.header?.windows.measurement.end ?? "",
            summary_state: "READY",
            next_cursor: page.nextCursor ?? "",
            total_row_count: String(page.totalRowCount),
            entry_kind: "statistic"
          },
          value: [time / 1000, stat.value === null ? "NaN" : String(stat.value)]
        });
    if (this.reader.read(runId).attemptToken !== token) throw new Error("summary_attempt_changed");
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
      throw new Error("summary_response_budget_exceeded");
    return result;
  }
  private async ranked(runId: string, labels: Map<string, string>, time: number): Promise<any[]> {
    const state = this.reader.read(runId),
      token = state.attemptToken,
      definition = labels.get("definition");
    if (!/^db\.table\.(read|create|update|delete|write)$/.test(definition ?? ""))
      throw new Error("saved_table_rank_definition_invalid");
    const selector = new TableRankSelector();
    for await (const row of this.reader.iterate(runId))
      if (row.definitionId === definition)
        selector.add(
          row.dimensions.table,
          row.statistics.total?.value === null || row.statistics.total?.value === undefined
            ? null
            : (row.statistics.total?.observedTotal ?? null)
        );
    const names = new Set(selector.names()),
      result: any[] = [];
    let remainder = 0,
      remainderObserved = 0,
      remainderEstimated = 0,
      remainderCount = 0,
      remainderUnknown = 0,
      remainderPartial = false,
      remainderUnit = "records";
    for await (const row of this.reader.iterate(runId)) {
      if (row.definitionId !== definition) continue;
      const total = row.statistics.total;
      if (!names.has(row.dimensions.table)) {
        if (total?.value === null || total?.value === undefined) remainderUnknown++;
        else {
          remainder += total.value;
          remainderObserved += total.observedTotal ?? 0;
          remainderEstimated += total.estimatedTotal ?? 0;
          remainderPartial ||= total.status === "partial";
          remainderUnit = total.unit;
          remainderCount++;
        }
        continue;
      }
      result.push({
        metric: {
          run_id: runId,
          table: row.dimensions.table,
          definition: row.definitionId,
          unit: row.totalUnit,
          status: total?.status ?? "unavailable",
          observed_total: String(total?.observedTotal ?? ""),
          estimated_total: String(total?.estimatedTotal ?? ""),
          ranking: "saved_observed_total",
          window_start: state.header?.windows.measurement.start ?? "",
          window_end: state.header?.windows.measurement.end ?? ""
        },
        value: [
          time / 1000,
          total?.value === null || total?.value === undefined ? "NaN" : String(total.value)
        ]
      });
    }
    if (remainderCount || remainderUnknown)
      result.push({
        metric: {
          run_id: runId,
          table: "Other",
          display_remainder: "true",
          definition,
          unit: remainderUnit,
          status: !remainderCount
            ? "unavailable"
            : remainderUnknown || remainderPartial
              ? "partial"
              : remainderEstimated
                ? "estimated"
                : "available",
          observed_total: String(remainderObserved),
          estimated_total: String(remainderEstimated),
          supported_constituents: String(remainderCount),
          unknown_constituents: String(remainderUnknown),
          coverage_model: "constituent_additive",
          window_start: state.header?.windows.measurement.start ?? "",
          window_end: state.header?.windows.measurement.end ?? "",
          ranking: "saved_observed_total"
        },
        value: [time / 1000, remainderCount ? String(remainder) : "NaN"]
      });
    if (this.reader.read(runId).attemptToken !== token) throw new Error("summary_attempt_changed");
    return result;
  }
}
