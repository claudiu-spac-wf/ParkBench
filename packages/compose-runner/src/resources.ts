import { isOwnedByRun } from "./ownership";
export interface RunResource {
  resourceType:
    "container" | "network" | "volume" | "compose_project" | "target_file" | "temporary_directory";
  resourceId: string;
  labels: Record<string, string>;
  createdAt: string;
  deletedAt?: string;
  cleanupResult?: string;
}
export function selectOwnedResources(resources: RunResource[], runId: string): RunResource[] {
  return resources.filter((resource) => isOwnedByRun(resource.labels, runId));
}
