import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
export interface ExecutionCapability {
  runId: string;
  revision: string;
}
export const executionScope = new AsyncLocalStorage<ExecutionCapability>();
export function executionRevision(db: DatabaseSync, experimentId: string): string | undefined {
  return (
    db
      .prepare("SELECT revision FROM experiment_execution WHERE experiment_id=?")
      .get(experimentId) as any
  )?.revision;
}
export function ensureExecutionRevision(db: DatabaseSync, experimentId: string): string {
  db.prepare("INSERT OR IGNORE INTO experiment_execution(experiment_id,revision) VALUES(?,?)").run(
    experimentId,
    randomUUID()
  );
  return executionRevision(db, experimentId)!;
}
export function actionFenced(db: DatabaseSync, experimentId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM experiment_actions WHERE experiment_id=? AND holds_fence=1")
    .get(experimentId);
}
export function runExecutionRevision(db: DatabaseSync, runId: string): string | undefined {
  return (db.prepare("SELECT revision FROM run_execution WHERE run_id=?").get(runId) as any)
    ?.revision;
}
export function ensureRunExecutionRevision(
  db: DatabaseSync,
  runId: string,
  experimentId: string
): string {
  db.prepare("INSERT OR IGNORE INTO run_execution(run_id,revision) VALUES(?,?)").run(
    runId,
    ensureExecutionRevision(db, experimentId)
  );
  return runExecutionRevision(db, runId)!;
}
export function runActionFenced(db: DatabaseSync, runId: string): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM experiment_actions a JOIN runs r ON r.experiment_id=a.experiment_id WHERE r.id=? AND a.holds_fence=1 AND (json_extract(a.document,'$.runId') IS NULL OR json_extract(a.document,'$.runId')=r.id)"
    )
    .get(runId);
}
export function assertExecutionWrite(db: DatabaseSync, runId: string, explicit?: string): void {
  const row = db.prepare("SELECT experiment_id FROM runs WHERE id=?").get(runId) as any;
  const scope = executionScope.getStore();
  if (!row) {
    if (scope?.runId === runId) throw new Error("execution_revision_stale");
    return;
  }
  if (runActionFenced(db, runId)) throw new Error("experiment_action_in_progress");
  const expected = explicit ?? (scope?.runId === runId ? scope.revision : undefined);
  if (
    expected &&
    expected !== (runExecutionRevision(db, runId) ?? executionRevision(db, row.experiment_id))
  )
    throw new Error("execution_revision_stale");
}
export function assertReferencesReadable(db: DatabaseSync, value: unknown): void {
  const ids = new Set<string>(
    (
      db
        .prepare(
          "SELECT experiment_id id FROM experiment_actions WHERE holds_fence=1 AND json_extract(document,'$.runId') IS NULL UNION SELECT r.id FROM runs r JOIN experiment_actions a ON a.experiment_id=r.experiment_id WHERE a.holds_fence=1 AND (json_extract(a.document,'$.runId') IS NULL OR json_extract(a.document,'$.runId')=r.id)"
        )
        .all() as any[]
    ).map((r) => r.id)
  );
  if (!ids.size) return;
  const visit = (v: any): boolean =>
    typeof v === "string"
      ? ids.has(v)
      : Array.isArray(v)
        ? v.some(visit)
        : !!v &&
          typeof v === "object" &&
          Object.entries(v).some(([key, value]) => visit(key) || visit(value));
  if (visit(value)) throw Error("experiment_action_in_progress");
}
