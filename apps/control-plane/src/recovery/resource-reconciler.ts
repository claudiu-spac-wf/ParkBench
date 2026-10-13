import { cleanupOwnedResources } from "../../../../packages/compose-runner/src/cleanup";
import { RunResource } from "../../../../packages/compose-runner/src/resources";
export function reconcileResources(resources: RunResource[], runId: string) {
  return cleanupOwnedResources(resources, runId);
}
