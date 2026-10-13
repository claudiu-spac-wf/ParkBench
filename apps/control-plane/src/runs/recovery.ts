import { Repositories } from "../db/repositories";
import { RunStateMachine } from "./state-machine";
import { Finalizer } from "./finalizer";
import { Run } from "../../../../packages/contracts/src/run";
export function reconcileInterruptedRuns(repositories: Repositories): number {
  let count = 0;
  for (const run of repositories.findNonterminalRuns()) {
    const machine = new RunStateMachine(repositories);
    machine.transition(
      run,
      "INTERRUPTED",
      "control-plane restarted during active run",
      "reconciler"
    );
    run.cleanupStatus = "PENDING";
    repositories.saveRun(run);
    repositories.updateExperimentStatus(run.experimentId, "INTERRUPTED", new Date().toISOString());
    count++;
  }
  return count;
}
export async function reconcileInterruptedRunsWithExport(
  repositories: Repositories,
  finalizer: Finalizer,
  cleanup?: (run: Run, stage: "beforeMetrics" | "cleanup") => Promise<void>
): Promise<number> {
  let count = 0;
  for (const run of repositories.findNonterminalRuns()) {
    const machine = new RunStateMachine(repositories);
    machine.transition(
      run,
      "INTERRUPTED",
      "control-plane restarted during active run",
      "reconciler"
    );
    run.failureKind = "interruption";
    run.failureReason = "control-plane restarted during active run";
    run.cleanupStatus = "PENDING";
    repositories.saveRun(run);
    const now = Date.now() / 1000;
    await finalizer.finalize(run, {
      terminalState: "INTERRUPTED",
      start: now - 60,
      end: now + 1,
      beforeMetrics: cleanup ? () => cleanup(run, "beforeMetrics") : undefined,
      cleanup: cleanup ? () => cleanup(run, "cleanup") : undefined
    });
    repositories.updateExperimentStatus(run.experimentId, "INTERRUPTED", new Date().toISOString());
    count++;
  }
  return count;
}

export async function retryPendingCleanup(
  repositories: Repositories,
  cleanup: (run: Run, stage: "beforeMetrics" | "cleanup") => Promise<void>
): Promise<number> {
  let count = 0;
  for (const run of repositories.findRunsNeedingCleanup()) {
    try {
      await cleanup(run, "cleanup");
      run.cleanupStatus = "COMPLETE";
    } catch (error) {
      run.cleanupStatus = "FAILED";
      repositories.saveEvent({
        runId: run.id,
        fromState: run.state,
        toState: run.state,
        occurredAt: new Date().toISOString(),
        actor: "reconciler",
        reason: "cleanup retry failed",
        details: { error: String(error) }
      });
    }
    repositories.saveRun(run);
    count++;
  }
  return count;
}
