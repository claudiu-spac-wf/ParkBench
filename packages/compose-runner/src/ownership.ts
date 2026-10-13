export const OWNERSHIP_LABELS = {
  managed: "parkbench.managed",
  runId: "parkbench.run_id",
  experimentId: "parkbench.experiment_id",
  component: "parkbench.component"
} as const;
export function ownershipLabels(
  runId: string,
  experimentId: string,
  component: string
): Record<string, string> {
  return {
    [OWNERSHIP_LABELS.managed]: "true",
    [OWNERSHIP_LABELS.runId]: runId,
    [OWNERSHIP_LABELS.experimentId]: experimentId,
    [OWNERSHIP_LABELS.component]: component
  };
}
export function isOwnedByRun(labels: Record<string, string>, runId: string): boolean {
  return labels[OWNERSHIP_LABELS.managed] === "true" && labels[OWNERSHIP_LABELS.runId] === runId;
}
