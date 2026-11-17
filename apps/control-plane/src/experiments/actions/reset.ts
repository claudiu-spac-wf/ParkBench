import { commandKeyHash } from "../../db/retired-commands";
import type { ActionRecord } from "./repository";
import type { Repositories } from "../../db/repositories";
import { freezeDiagnosticsConfig } from "../../../../../packages/contracts/src/measurement-diagnostics";
import { validateSavedSchedule } from "../../../../../packages/contracts/src/experiment-schedule-snapshot";
import { composeProjectName } from "../../../../../packages/compose-runner/src/project-name";
function references(value: any, ids: Set<string>): boolean {
  if (typeof value === "string") {
    if (ids.has(value)) return true;
    return value.split(/[/?#&=\s"'\\]/).some((part) => {
      if (ids.has(part) || ids.has(part.replace(/\.(?:jsonl?|csv|txt|log|ya?ml|zip|pf)$/i, "")))
        return true;
      // Operation names prefix exact IDs with a colon. Keep dotted/colon IDs
      // intact and never confuse a hyphenated prefix neighbour with the owner.
      for (let at = part.indexOf(":"); at >= 0; at = part.indexOf(":", at + 1))
        if (ids.has(part.slice(at + 1))) return true;
      return false;
    });
  }
  if (Array.isArray(value)) return value.some((v) => references(v, ids));
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).some(([key, v]) => references(key, ids) || references(v, ids))
  );
}
export function purgeExecutionRows(repositories: Repositories, action: ActionRecord): void {
  const db = repositories.client.db,
    runIds = action.manifest.runIds as string[],
    ids = new Set([
      ...(action.runId ? [] : [action.experimentId!]),
      ...runIds,
      ...(action.manifest.referenceIds ?? [])
    ]);
  for (const id of runIds) {
    db.prepare("DELETE FROM run_comparison_summary_rows WHERE run_id=?").run(id);
    db.prepare("DELETE FROM run_comparison_summaries WHERE run_id=?").run(id);
    for (const table of ["artifacts", "lifecycle_events", "resources", "environments"])
      db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(id);
  }
  for (const table of ["idempotency_keys", "control_command_results"]) {
    for (const row of db
      .prepare(`SELECT operation,idempotency_key,response FROM ${table}`)
      .iterate() as Iterable<any>) {
      let body;
      try {
        body = JSON.parse(row.response);
      } catch {
        body = row.response;
      }
      if (
        references(body, ids) ||
        (action.runId &&
          /experiment|queue-start/.test(row.operation) &&
          references(body, new Set([action.experimentId!]))) ||
        references(row.operation, ids) ||
        references(row.idempotency_key, ids)
      ) {
        db.prepare("INSERT OR REPLACE INTO retired_command_keys VALUES(?,?)").run(
          commandKeyHash(row.operation, row.idempotency_key),
          Date.now() + 86400000
        );
        db.prepare(`DELETE FROM ${table} WHERE operation=? AND idempotency_key=?`).run(
          row.operation,
          row.idempotency_key
        );
      }
    }
  }
  db.prepare(
    "DELETE FROM experiment_actions WHERE experiment_id=? AND id<>? AND holds_fence=0 AND (? IS NULL OR json_extract(document,'$.runId') IS NULL OR json_extract(document,'$.runId')=?)"
  ).run(action.experimentId!, action.id, action.runId ?? null, action.runId ?? null);
  const owner: any = db
    .prepare("SELECT preview_id FROM control_experiments WHERE experiment_id=?")
    .get(action.experimentId!);
  if (
    owner?.preview_id &&
    !db
      .prepare("SELECT 1 FROM control_experiments WHERE preview_id=? AND experiment_id<>?")
      .get(owner.preview_id, action.experimentId!)
  )
    db.prepare("DELETE FROM control_previews WHERE id=?").run(owner.preview_id);
}
export function resetExperiment(repositories: Repositories, action: ActionRecord): void {
  const snapshot = action.capsule;
  validateSavedSchedule(snapshot);
  const db = repositories.client.db,
    now = new Date().toISOString();
  purgeExecutionRows(repositories, action);
  const e = snapshot.experiment,
    c = snapshot.control;
  db.prepare(
    "UPDATE experiments SET scenario_id=?,scenario_version=?,comparison_mode=?,baseline_variant_id=?,repetitions=?,inputs=?,created_at=?,status='QUEUED',started_at=CASE WHEN ? THEN started_at ELSE NULL END,finished_at=NULL WHERE id=?"
  ).run(
    e.scenario_id,
    e.scenario_version,
    e.comparison_mode,
    e.baseline_variant_id ?? null,
    e.repetitions,
    e.inputs,
    e.created_at,
    Number(!!action.runId),
    action.experimentId!
  );
  if (!action.runId)
    db.prepare("DELETE FROM variants WHERE experiment_id=?").run(action.experimentId!);
  for (const v of action.runId ? [] : snapshot.variants)
    db.prepare(
      "INSERT INTO variants(experiment_id,id,name,parameters,document) VALUES(?,?,?,?,?)"
    ).run(action.experimentId!, v.id, v.name, v.parameters, v.document);
  const ordinal = (
    db.prepare("SELECT COALESCE(MAX(queue_ordinal),0)+1 AS n FROM control_experiments").get() as any
  ).n;
  db.prepare(
    "UPDATE control_experiments SET preview_id='',status='QUEUED',queue_ordinal=?,request_json=?,scenario_snapshot=?,matrix_spec=?,execution_policy=?,baseline_run_id=?,created_at=? WHERE experiment_id=?"
  ).run(
    ordinal,
    c.request_json,
    c.scenario_snapshot,
    c.matrix_spec,
    c.execution_policy,
    c.baseline_run_id ?? null,
    c.created_at,
    action.experimentId!
  );
  db.prepare(
    "INSERT OR IGNORE INTO run_execution(run_id,revision) SELECT r.id,e.revision FROM runs r JOIN experiment_execution e ON e.experiment_id=r.experiment_id WHERE r.experiment_id=?"
  ).run(action.experimentId!);
  db.prepare(
    "UPDATE experiment_execution SET revision=?,schedule_json=CASE WHEN ? THEN schedule_json ELSE ? END WHERE experiment_id=?"
  ).run(
    action.replacementRevision!,
    Number(!!action.runId),
    JSON.stringify(snapshot),
    action.experimentId!
  );
  for (const saved of snapshot.runs.filter(
    (r: any) => !action.runId || r.row.id === action.runId
  )) {
    db.prepare(
      "INSERT INTO run_execution(run_id,revision) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision"
    ).run(saved.row.id, action.replacementRevision!);
    const env = {
      ...saved.environment,
      createdAt: now,
      resolvedMeasurementDiagnostics: freezeDiagnosticsConfig(
        saved.environment.measurementDiagnostics,
        saved.diagnosticsPolicy as any,
        Date.now()
      )
    };
    db.prepare(
      "UPDATE runs SET variant_id=?,repetition=?,compose_project=?,resource_namespace=?,state='QUEUED',measurement_validity='PENDING',environment_snapshot=?,phase=NULL,started_at=NULL,measuring_at=NULL,finished_at=NULL,failure_kind=NULL,failure_reason=NULL,failure_code=NULL,completeness=NULL,cleanup_status='PENDING',summary=NULL,observer_health=NULL,phase_boundaries=NULL WHERE id=?"
    ).run(
      saved.row.variant_id,
      saved.row.repetition,
      composeProjectName(saved.row.id + "-" + action.replacementRevision!),
      JSON.stringify({
        ...JSON.parse(saved.row.resource_namespace),
        "parkbench.execution_revision": action.replacementRevision
      }),
      JSON.stringify(env),
      saved.row.id
    );
    const meta = saved.metadata;
    db.prepare(
      "UPDATE control_run_metadata SET experiment_id=?,cell_ordinal=?,repetition=?,values_json=?,effective_configuration=?,snapshot=?,queue_state='QUEUED',blocked_reason=NULL,next_retry_at=NULL,retry_count=0,updated_at=? WHERE run_id=?"
    ).run(
      action.experimentId!,
      meta.cell_ordinal,
      meta.repetition,
      meta.values_json,
      meta.effective_configuration,
      JSON.stringify({
        ...meta.snapshot,
        queuedAt: now,
        resolvedMeasurementDiagnostics: env.resolvedMeasurementDiagnostics
      }),
      now,
      saved.row.id
    );
  }
}
