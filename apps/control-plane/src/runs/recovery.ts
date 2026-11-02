import { Repositories } from "../db/repositories";
import { RunStateMachine } from "./state-machine";
import { Finalizer } from "./finalizer";
import { Run } from "../../../../packages/contracts/src/run";
function acceptedRecoveryState(run: Run): "FAILED" | "CANCELLED" | "INTERRUPTED" {
  const cause = (run.environmentSnapshot as any)?.databaseIopsEvidence?.terminationDecision?.cause;
  if (cause === "POLICY_DRIFT") {
    run.failureKind = "infrastructure";
    run.failureCode = "database_iops_policy_drift";
    run.failureReason = "Database IOPS policy drift confirmed before restart.";
    return "FAILED";
  }
  if (cause === "CANCELLED") {
    run.failureKind = "cancellation";
    run.failureReason = "Operator cancellation accepted before restart.";
    return "CANCELLED";
  }
  return "INTERRUPTED";
}
export function reconcileInterruptedRuns(repositories: Repositories): number {
  let count = 0;
  for (const run of repositories
    .findNonterminalRuns()
    .filter((candidate) => candidate.state !== "QUEUED")) {
    const machine = new RunStateMachine(repositories);
    const terminalState = acceptedRecoveryState(run);
    machine.transition(
      run,
      terminalState,
      "control-plane restarted during active run",
      "reconciler"
    );
    run.cleanupStatus = "PENDING";
    repositories.saveRun(run);
    repositories.updateExperimentStatus(run.experimentId, terminalState, new Date().toISOString());
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
  for (const run of repositories
    .findNonterminalRuns()
    .filter((candidate) => candidate.state !== "QUEUED")) {
    const machine = new RunStateMachine(repositories);
    const terminalState = acceptedRecoveryState(run);
    machine.transition(
      run,
      terminalState,
      "control-plane restarted during active run",
      "reconciler"
    );
    if (terminalState === "INTERRUPTED") {
      run.failureKind = "interruption";
      run.failureReason = "control-plane restarted during active run";
    }
    run.cleanupStatus = "PENDING";
    repositories.saveRun(run);
    const now = Date.now() / 1000;
    await finalizer.finalize(run, {
      terminalState,
      start: now - 60,
      end: now + 1,
      beforeMetrics: cleanup ? () => cleanup(run, "beforeMetrics") : undefined,
      cleanup: cleanup ? () => cleanup(run, "cleanup") : undefined
    });
    repositories.updateExperimentStatus(run.experimentId, terminalState, new Date().toISOString());
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
