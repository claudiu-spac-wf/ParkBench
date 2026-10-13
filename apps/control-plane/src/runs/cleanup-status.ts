export interface CleanupStatus {
  status: "PENDING" | "COMPLETE" | "PARTIAL" | "FAILED";
  resources: Array<{ id: string; result: string }>;
}
export function cleanupStatus(
  resources: Array<{ resourceId: string; cleanupResult?: string }>
): CleanupStatus {
  return {
    status: resources.every((resource) => resource.cleanupResult === "deleted")
      ? "COMPLETE"
      : "PARTIAL",
    resources: resources.map((resource) => ({
      id: resource.resourceId,
      result: resource.cleanupResult ?? "pending"
    }))
  };
}
