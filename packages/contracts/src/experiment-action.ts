import Ajv from "ajv/dist/2020";
import schema from "./schemas/experiment-action-v1.schema.json";
export const EXPERIMENT_ACTION_VERSION = "experiment-action.v1" as const;
export type ActionKind = "RERUN" | "REMOVE";
export const ACTION_STAGES = [
  "VALIDATING",
  "QUIESCING",
  "INVALIDATING_COMPARISONS",
  "DELETING_METRICS",
  "DELETING_FILES",
  "RESETTING",
  "REMOVING",
  "COMPLETE"
] as const;
export type ActionStage = (typeof ACTION_STAGES)[number];
export interface ActionRequest {
  contractVersion: typeof EXPERIMENT_ACTION_VERSION;
  kind: ActionKind;
  confirm: true;
  expectedRevision: string;
}
export interface ActionView {
  contractVersion: typeof EXPERIMENT_ACTION_VERSION;
  id: string;
  kind: ActionKind;
  status: "PENDING" | "FAILED" | "SUCCEEDED";
  stage: ActionStage;
  updatedAt: string;
  experimentId?: string;
  scope?: "RUN";
  runId?: string;
  runCount?: number;
  pollAfterMs?: number;
  failure?: { code: string; message: string; retryable: boolean };
  completedAt?: string;
  expiresAt?: string;
}
const ajv = new Ajv({ strict: true, allErrors: false });
const valid = ajv.compile(schema);
const validRetry = ajv.compile(schema.$defs.retry);
export function validateActionRequest(value: unknown): ActionRequest {
  if (!valid(value)) throw new Error("experiment_action_request_invalid");
  return value as ActionRequest;
}
export function validateActionRetry(value: unknown): void {
  if (!validRetry(value)) throw new Error("experiment_action_request_invalid");
}
export function requireActionKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new Error("idempotency_key_required");
  return value;
}
