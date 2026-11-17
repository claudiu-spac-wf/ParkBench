import type { Repositories } from "../../db/repositories";
import type { ActionRecord } from "./repository";
export function invalidateRerunComparisons(repositories: Repositories, action: ActionRecord): void {
  const db = repositories.client.db,
    ids = new Set<string>(action.manifest.runIds),
    time = new Date().toISOString(),
    refs: string[] = [];
  const notice = (id: string, reason: string) =>
    db
      .prepare("INSERT OR IGNORE INTO dashboard_unavailability(id,reason) VALUES(?,?)")
      .run(id, reason);
  db.prepare(
    "INSERT OR IGNORE INTO comparison_unavailability(id,reason,invalidated_at) VALUES(?,?,?)"
  ).run(action.experimentId!, "comparison_unavailable_experiment_rerun", time);
  for (const row of db
    .prepare(
      "SELECT c.* FROM control_comparisons c WHERE EXISTS (SELECT 1 FROM runs r WHERE r.experiment_id=? AND (r.id=c.baseline_run_id OR r.id IN (SELECT value FROM json_each(c.variant_run_ids))))"
    )
    .iterate(action.experimentId!) as Iterable<any>) {
    if (
      !ids.has(row.baseline_run_id) &&
      !JSON.parse(row.variant_run_ids).some((id: string) => ids.has(id))
    )
      continue;
    db.prepare(
      "INSERT OR IGNORE INTO comparison_unavailability(id,reason,invalidated_at) VALUES(?,?,?)"
    ).run(row.id, "comparison_unavailable_experiment_rerun", time);
    refs.push(row.id);
    db.prepare("DELETE FROM comparison_removed_members WHERE id=?").run(row.id);
    if (row.dashboard_context_id) {
      notice(row.dashboard_context_id, "dashboard_context_unavailable_experiment_rerun");
      refs.push(row.dashboard_context_id);
    }
    db.prepare("DELETE FROM control_comparisons WHERE id=?").run(row.id);
  }
  for (const row of db
    .prepare(
      "SELECT c.id,c.run_ids FROM control_dashboard_contexts c WHERE EXISTS (SELECT 1 FROM json_each(c.run_ids) j JOIN runs r ON r.id=j.value WHERE r.experiment_id=?)"
    )
    .iterate(action.experimentId!) as Iterable<any>) {
    const runs = JSON.parse(row.run_ids);
    if (!runs.some((id: string) => ids.has(id))) continue;
    notice(
      row.id,
      runs.length > 1
        ? "dashboard_context_unavailable_experiment_rerun"
        : "dashboard_context_execution_replaced"
    );
    refs.push(row.id);
    db.prepare("DELETE FROM control_dashboard_contexts WHERE id=?").run(row.id);
  }
  action.manifest.referenceIds = [...new Set([...(action.manifest.referenceIds ?? []), ...refs])];
}
