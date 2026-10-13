import { LifecycleEvent } from "../../../../packages/contracts/src/run";
import { Repositories } from "../db/repositories";
export class RunEventLog {
  constructor(private readonly repositories: Repositories) {}
  append(event: Omit<LifecycleEvent, "id">): LifecycleEvent {
    return this.repositories.saveEvent(event);
  }
  list(runId: string, after = 0): LifecycleEvent[] {
    return this.repositories.listEvents(runId, after);
  }
}
