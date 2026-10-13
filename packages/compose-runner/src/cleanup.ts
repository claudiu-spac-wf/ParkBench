import { RunResource, selectOwnedResources } from "./resources";
export function cleanupOwnedResources(resources: RunResource[], runId: string): RunResource[] {
  return selectOwnedResources(resources, runId).map((resource) => ({
    ...resource,
    deletedAt: new Date().toISOString(),
    cleanupResult: "deleted"
  }));
}
