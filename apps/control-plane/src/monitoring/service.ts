import { Repositories } from "../db/repositories";
export class MonitoringService {
  constructor(private readonly repositories: Repositories) {}
  run(runId: string) {
    return this.repositories.getRun(runId);
  }
  events(runId: string, after = 0) {
    return this.repositories.listEvents(runId, after);
  }
}
