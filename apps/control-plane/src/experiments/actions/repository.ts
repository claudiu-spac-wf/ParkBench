import { createHash, randomUUID } from "node:crypto";
import type {
  ActionKind,
  ActionStage,
  ActionView
} from "../../../../../packages/contracts/src/experiment-action";
import { DatabaseClient } from "../../db/client";
import { actionFenced, ensureExecutionRevision, runExecutionRevision } from "../../db/execution";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export interface ActionRecord extends ActionView {
  expectedRevision?: string;
  replacementRevision?: string;
  holdsFence: boolean;
  capsule?: any;
  manifest?: any;
  metricScope?: string[];
  checkpoints?: string[];
}
export class ActionRepository {
  constructor(readonly client: DatabaseClient) {}
  currentRevision(id: string): string {
    if (!this.client.db.prepare("SELECT 1 FROM experiments WHERE id=?").get(id))
      throw new Error("experiment_not_found");
    return ensureExecutionRevision(this.client.db, id);
  }
  isFenced(id: string): boolean {
    return actionFenced(this.client.db, id);
  }
  transaction<T>(fn: () => T): T {
    const nested = this.client.db.isTransaction;
    const savepoint = "action_" + randomUUID().replaceAll("-", "");
    this.client.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.client.db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.client.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      throw error;
    }
  }
  get(id: string, includePayload = true): ActionRecord | undefined {
    const row: any = this.client.db
      .prepare("SELECT document,expires_at FROM experiment_actions WHERE id=?")
      .get(id);
    if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) return undefined;
    const action = JSON.parse(row.document);
    if (includePayload)
      for (const section of action.payloadPages ?? []) {
        const items: any[] = [];
        for (const page of this.client.db
          .prepare(
            "SELECT document FROM experiment_action_pages WHERE action_id=? AND section=? ORDER BY ordinal"
          )
          .iterate(id, section) as Iterable<any>)
          items.push(...JSON.parse(page.document));
        const parts = section.split(".");
        let value = action;
        for (const part of parts.slice(0, -1)) value = value[part];
        value[parts.at(-1)!] = items;
      }
    delete action.payloadPages;
    return action;
  }
  receiptFor(
    key: string,
    experimentId: string,
    kind: ActionKind,
    revision: string,
    runId?: string
  ): ActionRecord | undefined {
    const row: any = this.client.db
      .prepare(
        "SELECT id,request_binding FROM experiment_actions WHERE key_hash=? AND (expires_at IS NULL OR expires_at>?)"
      )
      .get(digest(key), Date.now());
    if (!row) return undefined;
    if (
      row.request_binding !==
      digest(
        JSON.stringify(runId ? ["RUN", runId, kind, revision] : [experimentId, kind, revision])
      )
    )
      throw new Error("idempotency_conflict");
    return this.get(row.id);
  }
  reserve(
    experimentId: string,
    kind: ActionKind,
    expectedRevision: string,
    key: string,
    runId?: string
  ): ActionRecord {
    return this.transaction(() => {
      this.client.db
        .prepare(
          "DELETE FROM experiment_actions WHERE key_hash=? AND holds_fence=0 AND expires_at<=?"
        )
        .run(digest(key), Date.now());
      const replay = this.receiptFor(key, experimentId, kind, expectedRevision, runId);
      if (replay) return replay;
      if (
        (runId
          ? runExecutionRevision(this.client.db, runId)
          : this.currentRevision(experimentId)) !== expectedRevision
      )
        throw new Error("experiment_revision_stale");
      if (this.isFenced(experimentId)) throw new Error("experiment_action_in_progress");
      const action: ActionRecord = {
        contractVersion: "experiment-action.v1",
        id: "action_" + randomUUID(),
        kind,
        experimentId,
        ...(runId ? { scope: "RUN" as const, runId } : {}),
        expectedRevision,
        replacementRevision: kind === "RERUN" ? randomUUID() : undefined,
        status: "PENDING",
        stage: "VALIDATING",
        holdsFence: true,
        updatedAt: new Date().toISOString(),
        pollAfterMs: 1000
      };
      this.client.db
        .prepare(
          "INSERT INTO experiment_actions(id,experiment_id,kind,status,stage,holds_fence,key_hash,request_binding,document,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?)"
        )
        .run(
          action.id,
          experimentId,
          kind,
          action.status,
          action.stage,
          digest(key),
          digest(
            JSON.stringify(
              runId
                ? ["RUN", runId, kind, expectedRevision]
                : [experimentId, kind, expectedRevision]
            )
          ),
          JSON.stringify(action),
          action.updatedAt
        );
      return action;
    });
  }
  save(action: ActionRecord): void {
    this.transaction(() => {
      // Completion is immutable, including payload pages. A delayed old worker
      // must never recreate target-bearing recovery context after final commit.
      const stored = this.client.db
        .prepare("SELECT status FROM experiment_actions WHERE id=?")
        .get(action.id) as any;
      if (stored?.status === "SUCCEEDED") return;
      action.updatedAt = new Date().toISOString();
      const document: any = {
          ...action,
          manifest: action.manifest ? { ...action.manifest } : undefined,
          capsule: action.capsule ? { ...action.capsule } : undefined
        },
        sections: string[] = [];
      for (const section of [
        "capsule.runs",
        "capsule.variants",
        "manifest.runIds",
        "manifest.paths",
        "manifest.referenceIds",
        "metricScope"
      ]) {
        const parts = section.split(".");
        let parent = document;
        for (const part of parts.slice(0, -1)) parent = parent?.[part];
        const key = parts.at(-1)!,
          items = parent?.[key];
        if (!Array.isArray(items)) continue;
        sections.push(section);
        delete parent[key];
        let page: any[] = [],
          bytes = 2,
          ordinal = 0;
        const flush = () => {
          if (!page.length) return;
          this.client.db
            .prepare(
              "INSERT INTO experiment_action_pages VALUES(?,?,?,?) ON CONFLICT(action_id,section,ordinal) DO UPDATE SET document=excluded.document WHERE document<>excluded.document"
            )
            .run(action.id, section, ordinal++, JSON.stringify(page));
          page = [];
          bytes = 2;
        };
        for (const item of items) {
          const size = Buffer.byteLength(JSON.stringify(item)) + 1;
          if (page.length && (bytes + size > 512 * 1024 || page.length >= 256)) flush();
          page.push(item);
          bytes += size;
        }
        flush();
        this.client.db
          .prepare(
            "DELETE FROM experiment_action_pages WHERE action_id=? AND section=? AND ordinal>=?"
          )
          .run(action.id, section, ordinal);
      }
      document.payloadPages = sections;
      for (const row of this.client.db
        .prepare("SELECT DISTINCT section FROM experiment_action_pages WHERE action_id=?")
        .all(action.id) as any[])
        if (!sections.includes(row.section))
          this.client.db
            .prepare("DELETE FROM experiment_action_pages WHERE action_id=? AND section=?")
            .run(action.id, row.section);
      this.client.db
        .prepare(
          "UPDATE experiment_actions SET experiment_id=?,status=?,stage=?,holds_fence=?,document=?,updated_at=?,expires_at=? WHERE id=?"
        )
        .run(
          action.experimentId ?? null,
          action.status,
          action.stage,
          Number(action.holdsFence),
          JSON.stringify(document),
          action.updatedAt,
          action.expiresAt ? Date.parse(action.expiresAt) : null,
          action.id
        );
    });
  }
  stage(id: string, stage: ActionStage, extra: Partial<ActionRecord> = {}): ActionRecord {
    const action = this.get(id);
    if (!action) throw new Error("experiment_action_not_found");
    if (action.status === "SUCCEEDED") return action;
    Object.assign(action, extra, { stage, status: "PENDING", failure: undefined });
    this.save(action);
    return action;
  }
  fail(id: string, code: string, validation = false): void {
    const action = this.get(id);
    if (!action || action.status === "SUCCEEDED") return;
    Object.assign(action, {
      status: "FAILED",
      holdsFence: !validation,
      failure: { code, message: code.replaceAll("_", " "), retryable: true }
    });
    this.save(action);
  }
  retry(id: string): ActionRecord {
    return this.transaction(() => {
      const action = this.get(id);
      if (!action) throw new Error("experiment_action_not_found");
      if (action.status === "SUCCEEDED") return action;
      if (action.status !== "FAILED" || !action.failure?.retryable)
        throw new Error("experiment_action_in_progress");
      if (!action.holdsFence) {
        if (
          !action.experimentId ||
          (action.runId
            ? runExecutionRevision(this.client.db, action.runId)
            : this.currentRevision(action.experimentId)) !== action.expectedRevision
        )
          throw new Error("experiment_revision_stale");
        if (this.isFenced(action.experimentId)) throw new Error("experiment_action_in_progress");
      }
      action.holdsFence = true;
      action.status = "PENDING";
      action.failure = undefined;
      this.save(action);
      return action;
    });
  }
  latestFailure(experimentId: string): ActionRecord | undefined {
    const row: any = this.client.db
      .prepare(
        "SELECT document FROM experiment_actions WHERE experiment_id=? AND status='FAILED' ORDER BY updated_at DESC LIMIT 1"
      )
      .get(experimentId);
    return row ? JSON.parse(row.document) : undefined;
  }
  pending(): ActionRecord[] {
    return (
      this.client.db
        .prepare("SELECT document FROM experiment_actions WHERE holds_fence=1 ORDER BY updated_at")
        .all() as any[]
    ).map((row) => JSON.parse(row.document));
  }
  replaceRevision(experimentId: string, revision: string): void {
    this.transaction(()=>{
      this.client.db.prepare("UPDATE experiment_execution SET revision=? WHERE experiment_id=?").run(revision,experimentId);
      this.client.db.prepare("INSERT INTO run_execution(run_id,revision) SELECT id,? FROM runs WHERE experiment_id=? ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision").run(revision,experimentId);
    });
  }
  complete(id: string, finalize: (action: ActionRecord) => void): ActionRecord {
    return this.transaction(() => {
      const action = this.get(id);
      if (!action) throw new Error("experiment_action_not_found");
      if (action.status === "SUCCEEDED") return action;
      finalize(action);
      const time = new Date().toISOString();
      const receipt: ActionRecord = {
        contractVersion: "experiment-action.v1",
        id: action.id,
        kind: action.kind,
        ...(action.scope ? { scope: action.scope } : {}),
        status: "SUCCEEDED",
        stage: "COMPLETE",
        holdsFence: false,
        updatedAt: time,
        completedAt: time,
        expiresAt: new Date(Date.now() + 86400000).toISOString()
      };
      this.save(receipt);
      return receipt;
    });
  }
  view(action: ActionRecord): ActionView {
    const {
      contractVersion,
      id,
      kind,
      status,
      stage,
      updatedAt,
      experimentId,
      scope,
      runId,
      runCount,
      pollAfterMs,
      failure,
      completedAt,
      expiresAt
    } = action;
    return {
      contractVersion,
      id,
      kind,
      status,
      stage,
      updatedAt,
      ...(scope ? { scope } : {}),
      ...(experimentId ? { experimentId, runCount, pollAfterMs } : {}),
      ...(runId ? { runId } : {}),
      ...(failure ? { failure } : {}),
      ...(completedAt ? { completedAt, expiresAt } : {})
    };
  }
  purgeReceipts(): void {
    this.client.db.prepare("DELETE FROM retired_command_keys WHERE expires_at<=?").run(Date.now());
    this.client.db
      .prepare("DELETE FROM experiment_actions WHERE holds_fence=0 AND expires_at<=?")
      .run(Date.now());
  }
}
