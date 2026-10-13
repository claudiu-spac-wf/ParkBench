import { Run } from "../../../../packages/contracts/src/run";

export function classifyLoadgenExitCode(code: number): {
  state?: Run["state"];
  failureKind?: Run["failureKind"];
  reason?: string;
} {
  if (code === 0) return {};
  if (code === 10)
    return { state: "CANCELLED", failureKind: "cancellation", reason: "loadgen cancelled" };
  if (code === 30)
    return {
      state: "THRESHOLD_FAILED",
      failureKind: "threshold",
      reason: "loadgen threshold assertion failed"
    };
  if (code === 124)
    return {
      state: "FAILED",
      failureKind: "infrastructure",
      reason: "loadgen did not exit after cooldown"
    };
  return {
    state: "FAILED",
    failureKind: "infrastructure",
    reason: `loadgen exited with code ${code}`
  };
}
