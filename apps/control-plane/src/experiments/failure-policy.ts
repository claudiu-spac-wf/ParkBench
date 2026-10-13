export function shouldContinueAfterRun(state: string): boolean {
  return ["SUCCEEDED", "THRESHOLD_FAILED", "INCOMPLETE", "FAILED", "CANCELLED"].includes(state);
}
/**
 * Each run starts from its own fresh seed copy, so a failed or cancelled run does not affect the
 * next one: the experiment runs every remaining run and ends FAILED if any run failed. Only an
 * interrupted control plane stops the matrix.
 */
export function shouldStopMatrix(state: string): boolean {
  return state === "INTERRUPTED";
}
