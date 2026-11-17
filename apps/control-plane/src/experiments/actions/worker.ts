import type { ActionRecord } from "./repository";
import { ActionRepository } from "./repository";
import type { ActionStage } from "../../../../../packages/contracts/src/experiment-action";
export interface ActionHooks {
  validate(action: ActionRecord): Promise<Partial<ActionRecord>>;
  quiesce(action: ActionRecord): Promise<void>;
  invalidateComparisons(action: ActionRecord): Promise<void>;
  deleteMetrics(action: ActionRecord): Promise<void>;
  deleteFiles(action: ActionRecord): Promise<void>;
  finalize(action: ActionRecord): void;
  afterComplete?(action: ActionRecord): void;
}
export class ActionWorker {
  private tail = Promise.resolve();
  private jobs = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private readonly repository: ActionRepository,
    private readonly hooks: ActionHooks
  ) {}
  enqueue(id: string): void {
    if (this.closed || this.jobs.has(id)) return;
    const job = this.tail.then(() => this.perform(id)).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    this.tail = job.catch(() => undefined);
  }
  idle(): Promise<void> {
    return this.tail;
  }
  close(): Promise<void> {
    this.closed = true;
    return this.tail;
  }
  recover(): void {
    for (const action of this.repository.pending())
      if (action.status === "PENDING") this.enqueue(action.id);
  }
  private async perform(id: string): Promise<void> {
    try {
      for (;;) {
        if (this.closed) return;
        const action = this.repository.get(id);
        if (!action || action.status !== "PENDING") return;
        const next = (stage: ActionStage, extra: Partial<ActionRecord> = {}) => {
          if (!this.closed) this.repository.stage(id, stage, extra);
        };
        switch (action.stage) {
          case "VALIDATING": {
            const capsule = await this.hooks.validate(action);
            next("QUIESCING", capsule);
            break;
          }
          case "QUIESCING":
            await this.hooks.quiesce(action);
            next("INVALIDATING_COMPARISONS");
            break;
          case "INVALIDATING_COMPARISONS":
            await this.hooks.invalidateComparisons(action);
            next("DELETING_METRICS");
            break;
          case "DELETING_METRICS":
            await this.hooks.deleteMetrics(action);
            next("DELETING_FILES");
            break;
          case "DELETING_FILES":
            await this.hooks.deleteFiles(action);
            next(action.kind === "RERUN" ? "RESETTING" : "REMOVING");
            break;
          case "RESETTING":
          case "REMOVING": {
            this.repository.complete(id, (a) => this.hooks.finalize(a));
            this.hooks.afterComplete?.(action);
            return;
          }
          case "COMPLETE":
            return;
        }
      }
    } catch (error) {
      if (!this.closed) {
        const action = this.repository.get(id);
        const raw = error instanceof Error ? error.message : "";
        const code = /^experiment_[a-z_]{1,90}$/.test(raw) ? raw : "experiment_cleanup_failed";
        this.repository.fail(id, code, action?.stage === "VALIDATING");
      }
    }
  }
}
