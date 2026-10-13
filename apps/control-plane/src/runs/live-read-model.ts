import { Repositories } from "../db/repositories";

export class LiveRunReadModel {
  constructor(private readonly repositories: Repositories) {}

  status(runId: string) {
    return this.repositories.getRun(runId);
  }

  events(runId: string, after = 0) {
    return this.repositories.listEvents(runId, after);
  }

  monitoring(runId: string, observedAt = new Date().toISOString()) {
    const run = this.status(runId);
    if (!run) throw new Error("run_not_found");
    return {
      run,
      observedAt,
      stale: false,
      metrics: run.summary?.summaries ?? [],
      completeness: run.completeness
    };
  }
}
