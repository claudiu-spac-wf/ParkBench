import { Repositories } from "../db/repositories";

export class HistoryService {
  constructor(private readonly repositories: Repositories) {}

  run(runId: string) {
    const run = this.repositories.getRun(runId);
    if (!run) throw new Error("run_not_found");
    return {
      run,
      events: this.repositories.listEvents(runId),
      artifacts: this.repositories.listArtifacts(runId),
      resources: this.repositories.listResources(runId)
    };
  }
}
