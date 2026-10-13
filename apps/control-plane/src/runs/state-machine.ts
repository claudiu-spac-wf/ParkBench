import { Repositories } from "../db/repositories";
import { Run } from "../../../../packages/contracts/src/run";
import { assertTransition } from "../../../../packages/contracts/src/run-state";
export class RunStateMachine {
  constructor(private readonly repositories: Repositories) {}
  transition(
    run: Run,
    toState: Run["state"],
    reason: string,
    actor: "controller" | "operator" | "reconciler" = "controller",
    details?: Record<string, unknown>
  ): Run {
    assertTransition(run.state, toState);
    const previous = run.state;
    const previousPhase = run.phase ?? previous.toLowerCase();
    run.state = toState;
    run.phase = toState === "INTERRUPTED" ? previousPhase : toState.toLowerCase();
    if (toState === "MEASURING") run.measuringAt = new Date().toISOString();
    if (
      [
        "SUCCEEDED",
        "INCOMPLETE",
        "THRESHOLD_FAILED",
        "FAILED",
        "CANCELLED",
        "INTERRUPTED"
      ].includes(toState)
    )
      run.finishedAt = new Date().toISOString();
    this.repositories.saveRun(run);
    this.repositories.saveEvent({
      runId: run.id,
      fromState: previous,
      toState,
      occurredAt: new Date().toISOString(),
      actor,
      reason,
      details:
        toState === "INTERRUPTED"
          ? { ...(details ?? {}), interruptedPhase: previousPhase }
          : details
    });
    return run;
  }
}
