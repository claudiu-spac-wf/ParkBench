import { announceExperimentAction } from "./experiment-action-events";
import React, { useEffect, useRef, useState } from "react";
import { idempotencyKey } from "../api";
import {
  getExperimentActions,
  getRunActions,
  submitRunAction,
  getExperimentAction,
  submitExperimentAction,
  retryExperimentAction
} from "./control-ui-client";
import type { ActionKind, ActionView } from "../../../../packages/contracts/src/experiment-action";
import "./experiment-actions.css";
const reasons: Record<string, string> = {
  experiment_active: "An experiment is running. Wait for it to finish.",
  experiment_not_terminal: "Rerun is available after the experiment finishes.",
  run_not_terminal: "Rerun is available after this run finishes.",
  experiment_saved_schedule_incomplete:
    "The original settings are incomplete; this experiment cannot be rerun.",
  experiment_action_in_progress: "Cleanup is already in progress.",
  experiment_revision_stale:
    "The experiment changed. Close this dialog and review the current experiment."
};
const message = (e: any) =>
  reasons[e.code ?? e.message] ?? e.message ?? "Unable to load experiment actions.";
export function ExperimentActions({
  experimentId,
  runId,
  onAccepted,
  onComplete
}: {
  key?: any;
  experimentId: string;
  runId?: string;
  onAccepted?: () => void;
  onComplete?: (kind: ActionKind) => void;
}) {
  const [eligibility, setEligibility] = useState(undefined as any);
  const [runEligibility, setRunEligibility] = useState(undefined as any);
  const [selectedRunScope, setSelectedRunScope] = useState(false);
  const [error, setError] = useState("");
  const [kind, setKind] = useState(undefined as ActionKind | undefined);
  const [stale, setStale] = useState(false);
  const [action, setAction] = useState(undefined as ActionView | undefined);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const dialog = useRef(null as HTMLDialogElement | null),
    trigger = useRef(undefined as HTMLElement | undefined);
  const key = useRef("");
  const inFlight = useRef(false),
    generation = useRef(0),
    completed = useRef(""),
    scope = useRef(0),
    acceptedCallback = useRef(onAccepted);
  acceptedCallback.current = onAccepted;
  const refresh = async () => {
    const epoch = ++generation.current;
    try {
      const [e, r] = await Promise.all([
        getExperimentActions(experimentId),
        runId ? getRunActions(runId) : Promise.resolve(undefined)
      ]);
      if (epoch !== generation.current) return;
      setEligibility(e);
      setRunEligibility(r);
      if (e.pendingActionId) {
        const a = await getExperimentAction(e.pendingActionId);
        if (epoch === generation.current) setAction(a);
      }
    } catch (e) {
      if (epoch === generation.current) setError(message(e));
    }
  };
  useEffect(() => {
    scope.current++;
    inFlight.current = false;
    key.current = "";
    setBusy(false);
    setVisible(false);
    setKind(undefined);
    setStale(false);
    setEligibility(undefined);
    setRunEligibility(undefined);
    setSelectedRunScope(false);
    setAction(undefined);
    setError("");
    void refresh();
    return () => {
      scope.current++;
      generation.current++;
    };
  }, [experimentId, runId]);
  useEffect(() => {
    if (
      !eligibility ||
      (action && action.status !== "SUCCEEDED") ||
      (eligibility.rerun.allowed && (!runId || runEligibility?.rerun.allowed))
    )
      return;
    const timer = setTimeout(() => void refresh(), 4000);
    return () => clearTimeout(timer);
  }, [eligibility, runEligibility, runId, action]);
  useEffect(() => {
    if (!action || action.status !== "PENDING") return;
    let disposed = false;
    const timer = setTimeout(() => {
      void getExperimentAction(action.id)
        .then((a) => {
          if (!disposed) {
            setAction(a);
            setError("");
          }
        })
        .catch((e) => {
          if (!disposed) setError(message(e));
        });
    }, action.pollAfterMs ?? 750);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [action, error]);
  useEffect(() => {
    if (action?.status === "SUCCEEDED" && completed.current !== action.id) {
      completed.current = action.id;
      onComplete?.(action.kind);
      void refresh();
    }
  }, [action]);
  useEffect(() => {
    if (visible) {
      dialog.current?.showModal();
      dialog.current?.querySelector("button")?.focus();
    } else if (dialog.current?.open) dialog.current.close();
  }, [visible]);
  const close = () => {
    setVisible(false);
    setKind(undefined);
    setError("");
    trigger.current?.focus();
    void refresh();
  };
  const open = (next: ActionKind, event: React.MouseEvent, oneRun = false) => {
    trigger.current = event.currentTarget as HTMLElement;
    key.current = idempotencyKey();
    setKind(next);
    setSelectedRunScope(oneRun);
    setStale(false);
    setAction(undefined);
    setError("");
    setVisible(true);
  };
  const accept = async (retry = false) => {
    if (inFlight.current) return;
    const epoch = scope.current;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const a =
        retry && action
          ? await retryExperimentAction(action.id, key.current || idempotencyKey())
          : selectedRunScope && runId
            ? await submitRunAction(runId, runEligibility.executionRevision, key.current)
            : await submitExperimentAction(
                experimentId,
                kind!,
                eligibility.executionRevision,
                key.current
              );
      announceExperimentAction(experimentId);
      if (epoch !== scope.current) return;
      setAction(a);
      acceptedCallback.current?.();
    } catch (e) {
      if (epoch !== scope.current) return;
      setError(message(e));
      if ((e as any).code === "experiment_revision_stale") setStale(true);
    } finally {
      if (epoch === scope.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const pending = action && action.status !== "SUCCEEDED";
  const locked =
    action?.status === "PENDING" || (action?.status === "FAILED" && action.stage !== "VALIDATING");
  const oneRun = action ? action.scope === "RUN" : selectedRunScope;
  return (
    <section className="experiment-actions" aria-label="Experiment actions">
      <div className="experiment-action-buttons">
        {runId && (
          <button
            type="button"
            className="button secondary"
            disabled={!runEligibility?.rerun.allowed || locked}
            title={runEligibility?.rerun.reasons.map((r: string) => reasons[r] ?? r).join(" ")}
            onClick={(e) => open("RERUN", e, true)}
          >
            Rerun this run
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={!eligibility?.rerun.allowed || locked}
          title={eligibility?.rerun.reasons.map((r: string) => reasons[r] ?? r).join(" ")}
          onClick={(e) => open("RERUN", e)}
        >
          Rerun experiment
        </button>
        {eligibility?.remove.reasons?.[0] !== "experiment_removal_not_enabled" && (
          <button
            type="button"
            className="button secondary"
            disabled={!eligibility?.remove.allowed || locked}
            onClick={(e) => open("REMOVE", e)}
          >
            Remove experiment
          </button>
        )}
        {pending && (
          <button
            type="button"
            onClick={() => {
              setKind(action.kind);
              setVisible(true);
            }}
          >
            View {action.status === "FAILED" ? "failed cleanup" : "cleanup progress"}
          </button>
        )}
      </div>
      {!eligibility && !error && <p role="status">Loading experiment actions…</p>}
      {!visible && error && (
        <p role="alert">
          {error} <button onClick={() => void refresh()}>Reload actions</button>
        </p>
      )}
      {action?.status === "SUCCEEDED" && !visible && (
        <p role="status">
          {action.kind === "RERUN"
            ? action.scope === "RUN"
              ? "Run queued for rerun."
              : "Experiment queued for rerun."
            : "Experiment removed."}
        </p>
      )}
      <dialog
        ref={dialog}
        className="experiment-action-dialog"
        aria-labelledby={`action-title-${experimentId}`}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onClose={() => {
          setVisible(false);
          trigger.current?.focus();
        }}
      >
        <h2 id={`action-title-${experimentId}`}>
          {action
            ? action.status === "SUCCEEDED"
              ? "Cleanup complete"
              : oneRun
                ? "Run cleanup"
                : "Experiment cleanup"
            : kind === "REMOVE"
              ? "Remove experiment?"
              : oneRun
                ? "Rerun run?"
                : "Rerun experiment?"}
        </h2>
        {!action && (
          <>
            {oneRun ? (
              <p>
                This affects only <strong>{runEligibility?.runName}</strong> (1 run) in experiment{" "}
                <strong>{eligibility?.experimentName}</strong>. Other runs keep their results.
              </p>
            ) : (
              <p>
                This affects the entire experiment <strong>{eligibility?.experimentName}</strong> (
                {eligibility?.runCount} runs), including successful runs.
              </p>
            )}
            <p>
              {kind === "REMOVE"
                ? "All experiment data and the experiment entry will be permanently deleted. It will disappear from history."
                : oneRun
                  ? "This run’s previous results, metrics, logs and artifacts will be permanently deleted. It will be queued again with its original ID, name and saved settings."
                  : "All previous results, metrics, logs and artifacts will be permanently deleted. Every run will be queued again with its original ID, name and saved settings."}
            </p>
            {kind === "RERUN" && (
              <>
                <p role="note">
                  Changes to workloads, startup.pf or the database seed since the original run are
                  not restored or accounted for. Reusing these inputs may produce inaccurate or
                  incomparable data.
                </p>
                <p>
                  Every saved comparison containing {oneRun ? "this run" : "these runs"} becomes
                  permanently unavailable. Create a new comparison after the rerun.
                </p>
              </>
            )}
          </>
        )}
        {action && (
          <div aria-live="polite">
            {action.scope === "RUN" && action.runId && (
              <p>
                This cleanup affects only run <strong>{action.runId}</strong> (1 run). Other runs
                keep their results.
              </p>
            )}
            <p>
              {action.status === "SUCCEEDED"
                ? action.kind === "RERUN"
                  ? oneRun
                    ? "The run is queued for rerun."
                    : "The experiment is queued for rerun."
                  : "The experiment was removed."
                : `${action.status === "FAILED" ? "Cleanup stopped" : "Cleanup in progress"}: ${action.stage.toLowerCase().replaceAll("_", " ")}.`}
            </p>
            {action.failure && (
              <p role="alert">
                {action.failure.message} ({action.failure.code})
              </p>
            )}
            {action.status !== "SUCCEEDED" && (
              <p>
                Closing this dialog does not cancel accepted cleanup. You can reopen its progress
                from this experiment.
              </p>
            )}
          </div>
        )}
        {busy && !action && (
          <p role="status">
            Confirmation is being sent. Closing this dialog does not cancel the request.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="experiment-action-buttons">
          <button type="button" className="button secondary" onClick={close}>
            {action || busy ? "Close" : "Cancel"}
          </button>
          {!action && (
            <button type="button" disabled={busy || stale} onClick={() => void accept()}>
              {busy
                ? "Accepting…"
                : kind === "REMOVE"
                  ? "Remove experiment"
                  : oneRun
                    ? "Rerun this run"
                    : "Rerun experiment"}
            </button>
          )}
          {action?.status === "FAILED" && action.failure?.retryable && (
            <button disabled={busy} onClick={() => void accept(true)}>
              {busy ? "Retrying…" : "Retry cleanup"}
            </button>
          )}
        </div>
      </dialog>
    </section>
  );
}
