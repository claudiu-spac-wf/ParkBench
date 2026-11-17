import type { Repositories } from "../../db/repositories";
import type { ActionRecord } from "./repository";
import { purgeExecutionRows } from "./reset";
/** Runs only inside the action's final transaction; the receipt is committed with it. */
export function removeExperiment(repositories: Repositories, action: ActionRecord): void {
  const db = repositories.client.db,
    id = action.experimentId!;
  purgeExecutionRows(repositories, action);
  for (const runId of action.manifest.runIds)
    db.prepare("DELETE FROM control_run_metadata WHERE run_id=?").run(runId);
  db.prepare("DELETE FROM runs WHERE experiment_id=?").run(id);
  db.prepare("DELETE FROM variants WHERE experiment_id=?").run(id);
  db.prepare("DELETE FROM control_experiments WHERE experiment_id=?").run(id);
  db.prepare("DELETE FROM experiment_execution WHERE experiment_id=?").run(id);
  db.prepare("DELETE FROM experiments WHERE id=?").run(id);
  db.prepare("DELETE FROM comparison_unavailability WHERE id=?").run(id);
}
export function removeComparisonMembers(repositories: Repositories, action: ActionRecord): void {
  const db = repositories.client.db,
    ids = new Set<string>(action.manifest.runIds),
    refs: string[] = [];
  for (const row of db
    .prepare(
      "SELECT c.* FROM control_comparisons c WHERE EXISTS (SELECT 1 FROM runs r WHERE r.experiment_id=? AND (r.id=c.baseline_run_id OR r.id IN (SELECT value FROM json_each(c.variant_run_ids))))"
    )
    .iterate(action.experimentId!) as Iterable<any>) {
    const variants = JSON.parse(row.variant_run_ids) as string[],
      baselineRemoved = ids.has(row.baseline_run_id),
      removed = new Set(
        [...variants, ...(row.baseline_run_id ? [row.baseline_run_id] : [])].filter((id) =>
          ids.has(id)
        )
      );
    if (!removed.size) continue;
    if (row.dashboard_context_id) {
      refs.push(row.dashboard_context_id);
      db.prepare("DELETE FROM control_dashboard_contexts WHERE id=?").run(row.dashboard_context_id);
    }
    const remaining = variants.filter((id) => !ids.has(id)),
      baseline = baselineRemoved ? null : row.baseline_run_id;
    if (!remaining.length && !baseline) {
      refs.push(row.id);
      db.prepare("DELETE FROM comparison_removed_members WHERE id=?").run(row.id);
      db.prepare("DELETE FROM control_comparisons WHERE id=?").run(row.id);
      continue;
    }
    db.prepare(
      "UPDATE control_comparisons SET experiment_id=CASE WHEN experiment_id=? THEN NULL ELSE experiment_id END,baseline_run_id=?,variant_run_ids=?,eligibility=?,eligibility_reasons='[]',shared_context='{}',dashboard_context_id=NULL,selection_revision=selection_revision+1 WHERE id=?"
    ).run(
      action.experimentId!,
      baseline,
      JSON.stringify(remaining),
      baseline ? "VALID" : "DESCRIPTIVE_ONLY",
      row.id
    );
    db.prepare(
      "INSERT INTO comparison_removed_members(id,member_count,baseline_removed) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET member_count=member_count+excluded.member_count,baseline_removed=MAX(baseline_removed,excluded.baseline_removed)"
    ).run(row.id, removed.size, Number(baselineRemoved));
  }
  for (const row of db
    .prepare(
      "SELECT c.id,c.run_ids FROM control_dashboard_contexts c WHERE EXISTS (SELECT 1 FROM json_each(c.run_ids) j JOIN runs r ON r.id=j.value WHERE r.experiment_id=?)"
    )
    .iterate(action.experimentId!) as Iterable<any>) {
    if (JSON.parse(row.run_ids).some((id: string) => ids.has(id))) {
      refs.push(row.id);
      db.prepare("DELETE FROM control_dashboard_contexts WHERE id=?").run(row.id);
    }
  }
  action.manifest.referenceIds = [...new Set([...(action.manifest.referenceIds ?? []), ...refs])];
}
