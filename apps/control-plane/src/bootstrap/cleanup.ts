import { cleanupOwnedResources } from "../../../../packages/compose-runner/src/cleanup";
import { RunResource } from "../../../../packages/compose-runner/src/resources";
export function cleanupBootstrap(resources: RunResource[], runId: string): RunResource[] {
  return cleanupOwnedResources(resources, runId);
}
