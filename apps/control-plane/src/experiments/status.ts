export function aggregateExperimentStatus(states: string[], exploratory = false): string {
  if (!states.length) return "QUEUED";
  if (states.some((state) => state === "INTERRUPTED")) return "INTERRUPTED";
  if (states.some((state) => state === "FAILED")) return "FAILED";
  if (states.some((state) => state === "CANCELLED")) return "CANCELLED";
  if (states.some((state) => ["INCOMPLETE", "THRESHOLD_FAILED"].includes(state)) || exploratory)
    return "PARTIAL";
  if (states.every((state) => state === "SUCCEEDED")) return "SUCCEEDED";
  return "RUNNING";
}
