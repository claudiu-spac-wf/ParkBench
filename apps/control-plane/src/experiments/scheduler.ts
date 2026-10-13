import { expandMatrix } from "./matrix";
import { ExperimentRequest } from "../../../../packages/contracts/src/experiment";
export function scheduleMatrix(request: ExperimentRequest) {
  return expandMatrix(request);
}
