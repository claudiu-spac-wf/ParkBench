import { Repositories } from "../db/repositories";
import { reconcileInterruptedRuns } from "../runs/recovery";
import { reconcileInterruptedRunsWithExport } from "../runs/recovery";
import { retryPendingCleanup } from "../runs/recovery";
import { Finalizer } from "../runs/finalizer";
import { Run } from "../../../../packages/contracts/src/run";
export class StartupReconciler {
  constructor(
    private readonly repositories: Repositories,
    private readonly finalizer?: Finalizer,
    private readonly cleanup?: (run: Run, stage: "beforeMetrics" | "cleanup") => Promise<void>,
    private readonly bootstrapCleanup?: () => Promise<number>
  ) {}
  async run(): Promise<number> {
    const interrupted = this.finalizer
      ? await reconcileInterruptedRunsWithExport(this.repositories, this.finalizer, this.cleanup)
      : reconcileInterruptedRuns(this.repositories);
    const retries = this.cleanup ? await retryPendingCleanup(this.repositories, this.cleanup) : 0;
    const bootstrapRetries = this.bootstrapCleanup ? await this.bootstrapCleanup() : 0;
    return interrupted + retries + bootstrapRetries;
  }
}
