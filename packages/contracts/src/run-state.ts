import { RunState, RUN_STATES } from "./run";
export const TERMINAL_STATES: RunState[] = [
  "SUCCEEDED",
  "INCOMPLETE",
  "THRESHOLD_FAILED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
];
const NEXT: Record<string, RunState[]> = {
  QUEUED: ["PROVISIONING", "CANCELLED", "FAILED", "INTERRUPTED"],
  PROVISIONING: ["DB_READY", "FAILED", "CANCELLED", "INTERRUPTED"],
  DB_READY: ["PAS_READY", "FAILED", "CANCELLED", "INTERRUPTED"],
  PAS_READY: ["WARMING_UP", "FAILED", "CANCELLED", "INTERRUPTED"],
  WARMING_UP: ["MEASURING", "FAILED", "CANCELLED", "INTERRUPTED"],
  MEASURING: ["COOLDOWN", "INCOMPLETE", "FAILED", "CANCELLED", "INTERRUPTED"],
  COOLDOWN: ["FINALIZING", "FAILED", "CANCELLED", "INTERRUPTED"],
  FINALIZING: [...TERMINAL_STATES],
  SUCCEEDED: [],
  INCOMPLETE: [],
  THRESHOLD_FAILED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: []
};
export function canTransition(from: RunState, to: RunState): boolean {
  return from === to || (NEXT[from] ?? []).includes(to);
}
export function assertTransition(from: RunState, to: RunState): void {
  if (!RUN_STATES.includes(to) || !canTransition(from, to))
    throw new Error(`invalid_run_transition:${from}->${to}`);
}
export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}
