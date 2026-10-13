import { RunResource } from "../../compose-runner/src/resources";
import { isOwnedByRun } from "../../compose-runner/src/ownership";
export class FakeDocker {
  resources: RunResource[] = [];
  create(resource: RunResource): void {
    this.resources.push(resource);
  }
  removeOwned(runId: string): RunResource[] {
    const removed = this.resources.filter((resource) => isOwnedByRun(resource.labels, runId));
    this.resources = this.resources.filter((resource) => !isOwnedByRun(resource.labels, runId));
    return removed;
  }
}
