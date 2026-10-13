import { RunCoordinator } from "../runs/coordinator";
import { ExperimentRequest } from "../../../../packages/contracts/src/experiment";
import { Scenario } from "../../../../packages/contracts/src/scenario";
export class ExperimentService {
  constructor(private readonly coordinator: RunCoordinator) {}
  create(request: ExperimentRequest, scenario: Scenario) {
    const experiment = this.coordinator.createExperiment(request, scenario);
    this.coordinator.startExperiment(experiment.id);
    return experiment;
  }
}
