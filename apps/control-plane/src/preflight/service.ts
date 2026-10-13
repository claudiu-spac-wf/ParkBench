import { ExperimentRequest } from "../../../../packages/contracts/src/experiment";
import { Scenario } from "../../../../packages/contracts/src/scenario";
import {
  validateExperimentRequest,
  PreflightOptions
} from "../../../../packages/compose-runner/src/preflight";
export function preflight(
  request: ExperimentRequest,
  scenario: Scenario,
  options?: PreflightOptions
) {
  return validateExperimentRequest(request, scenario, options);
}
