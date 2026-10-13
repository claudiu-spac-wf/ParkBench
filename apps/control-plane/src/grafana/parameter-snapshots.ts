import fs from "node:fs";
import {
  validateDatabaseParameterSnapshot,
  DatabaseParameterSnapshot
} from "../../../../packages/contracts/src/database-parameter-snapshot";
import { Repositories } from "../db/repositories";
import { ArtifactStorage } from "../artifacts/storage";
import type { PromQuery } from "./table-ranking";
export class ParameterSnapshotQueries {
  constructor(
    private readonly repositories: Repositories,
    private readonly storage: ArtifactStorage
  ) {}
  async query(
    runId: string,
    kind: "info" | "numeric" | "status",
    time: number,
    upstream: PromQuery
  ): Promise<any[]> {
    const run = this.repositories.getRun(runId);
    if (!run) return [];
    const primary = this.repositories
      .listArtifacts(runId)
      .find((a) => a.kind === "db_parameter_snapshot");
    if (primary) {
      const file = this.storage.safePath(primary.path);
      if (fs.statSync(file).size > 4 * 1024 * 1024)
        throw new Error("parameter_snapshot_budget_exceeded");
      const snapshot = validateDatabaseParameterSnapshot(JSON.parse(fs.readFileSync(file, "utf8")));
      if (snapshot.runId !== runId || snapshot.experimentId !== run.experimentId)
        throw new Error("parameter_snapshot_owner_invalid");
      return this.fromSnapshot(snapshot, kind, time);
    }
    // Compatibility uses only the recorded run window, independent of the visible chart/phase.
    const start = Date.parse(run.startedAt ?? "");
    const end = Date.parse(run.finishedAt ?? "");
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const metric = `parkbench_openedge_db_parameter_snapshot_${kind}`;
      const result = await upstream(
        "query",
        new URLSearchParams({
          query: `last_over_time(${metric}{run_id=${JSON.stringify(runId)}}[${Math.round(end - start) + 1}ms] @ ${end / 1000})`,
          time: String(end / 1000)
        })
      );
      const rows = result.data?.result ?? [];
      if (rows.length > 10000) throw new Error("parameter_snapshot_budget_exceeded");
      if (rows.length) {
        if (kind === "info") {
          const captured = await upstream(
            "query",
            new URLSearchParams({
              query: `last_over_time(parkbench_openedge_db_parameter_snapshot_timestamp_seconds{run_id=${JSON.stringify(runId)}}[${Math.round(end - start) + 1}ms] @ ${end / 1000})`,
              time: String(end / 1000)
            })
          );
          for (const row of rows) {
            const timestamp = captured.data?.result?.find(
              (r: any) => r.metric.database_name === row.metric.database_name
            )?.value?.[1];
            row.value = [
              time / 1000,
              timestamp === undefined ? "NaN" : String(Number(timestamp) * 1000)
            ];
            row.metric.lookup_source = "historical_prometheus";
          }
        } else for (const row of rows) row.value = [time / 1000, row.value?.[1] ?? "NaN"];
        return rows;
      }
    }
    const state = (run.environmentSnapshot as any)?.parameterSnapshotCapture
      ? "no_snapshot"
      : "pre_feature";
    return kind === "status"
      ? [
          {
            metric: { run_id: runId, state, reason: "retained_snapshot_not_found" },
            value: [time / 1000, "1"]
          }
        ]
      : [];
  }
  private fromSnapshot(s: DatabaseParameterSnapshot, kind: string, time: number): any[] {
    const base = {
      run_id: s.runId,
      experiment_id: s.experimentId,
      database_name: s.databaseName,
      lookup_source: "retained_primary_snapshot"
    };
    if (kind === "status")
      return [
        {
          metric: {
            ...base,
            state: s.status,
            reason: s.reason ?? "",
            gaps: (s.gaps ?? []).join("; ")
          },
          value: [time / 1000, "1"]
        }
      ];
    return s.rows
      .filter((r) => kind !== "numeric" || Number.isFinite(r.numericValue))
      .map((r) => ({
        metric: {
          ...base,
          parameter: r.name,
          display_value: r.displayValue ?? "unknown",
          value_status: r.valueStatus,
          captured_at: s.capturedAt ?? s.attemptedAt
        },
        value: [
          time / 1000,
          String(kind === "numeric" ? r.numericValue : Date.parse(s.capturedAt ?? s.attemptedAt))
        ]
      }));
  }
}
