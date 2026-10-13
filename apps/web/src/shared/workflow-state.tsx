import React from "react";

export type WorkflowStateKind =
  | "loading"
  | "empty"
  | "no-match"
  | "unavailable"
  | "invalid"
  | "error"
  | "success"
  | "stale"
  | "pending"
  | "completed"
  | "failed";

export function WorkflowState({
  state,
  message,
  action,
  onAction
}: {
  state: WorkflowStateKind;
  message: string;
  action?: string;
  onAction?: () => void;
}) {
  const role = ["error", "failed", "invalid"].includes(state) ? "alert" : "status";
  return (
    <div className={`workflow-state workflow-state-${state}`} role={role}>
      <span>{message}</span>
      {action && onAction && (
        <button type="button" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}
