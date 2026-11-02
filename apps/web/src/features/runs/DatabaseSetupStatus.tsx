import React from "react";
import { getDatabaseSetup, SetupView } from "./databaseSetupApi";
import { DatabaseSetupSummary } from "../experiments/DatabaseSetupFields";
const phaseLabels: Record<string, string> = {
  staged: "Waiting to prepare database",
  preparing: "Preparing database",
  "step-running": "Running setup step",
  "temporary-startup": "Starting temporary maintenance broker",
  "temporary-ready": "Temporary maintenance broker ready",
  utility: "Running database setup",
  "waiting-processes": "Waiting for background processes",
  "temporary-shutdown": "Stopping temporary maintenance broker",
  "awaiting-normal-start": "Setup complete · database offline · awaiting normal startup",
  released: "Normal startup authorized",
  complete: "Database setup complete"
};
export function DatabaseSetupStatus({ runId }: { runId: string }) {
  const [value, setValue] = React.useState(undefined as SetupView | undefined);
  const [error, setError] = React.useState("");
  const [refresh, setRefresh] = React.useState(0);
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    let disposed = false,
      pending = false,
      done = false;
    const load = () => {
      if (pending || done) return;
      pending = true;
      void getDatabaseSetup(runId)
        .then((next) => {
          if (disposed) return;
          setValue(next);
          setError("");
          done =
            next.state === "NOT_REQUESTED" ||
            ["FAILED", "CANCELLED", "INTERRUPTED"].includes(next.state) ||
            next.normalStart === "STARTED";
        })
        .catch((reason) => {
          if (!disposed) setError(reason.message);
        })
        .finally(() => {
          pending = false;
        });
    };
    load();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      load();
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [runId, refresh]);
  if (value?.state === "NOT_REQUESTED") return null;
  const elapsed = value?.startedAt
    ? Math.max(
        0,
        Math.floor(
          ((value.finishedAt ? Date.parse(value.finishedAt) : now) - Date.parse(value.startedAt)) /
            1000
        )
      )
    : null;
  return (
    <section className="panel database-setup-status" aria-label="Database setup status">
      <h2>Database setup</h2>
      {error && (
        <p role="alert">
          Setup status unavailable: {error}{" "}
          <button type="button" onClick={() => setRefresh((v) => v + 1)}>
            Retry setup status
          </button>
        </p>
      )}
      {!value && !error && <p role="status">Loading database setup…</p>}
      {value && (
        <>
          <p role="status">
            {phaseLabels[value.phase] ?? value.phase} · {value.state}
            {elapsed !== null ? ` · ${elapsed} s` : ""}
          </p>
          {value.activeStepId && (
            <p>
              Step {value.activeStepId}
              {value.activeOptionSetId ? ` · settings ${value.activeOptionSetId}` : ""}
            </p>
          )}
          <p>
            Normal startup: {value.normalStart} · Cleanup: {value.cleanup}
          </p>
          {value.failure && (
            <p role="alert">
              {value.failure.code}: {value.failure.message}
            </p>
          )}
          <ol>
            {value.steps.map((step, si) => (
              <li key={step.id}>
                <strong>
                  {si + 1}. {step.definitionId}
                </strong>{" "}
                · {step.state}
                {step.startup && (
                  <p>
                    Temporary startup: {step.startup.state} · exit{" "}
                    {step.startup.exitStatus ?? "unobserved"}
                  </p>
                )}
                <ol>
                  {step.optionSets.map((set, oi) => (
                    <li key={set.id}>
                      <strong>Settings {oi + 1}</strong> · {set.state}
                      {set.exitStatus !== null ? ` · exit ${set.exitStatus}` : ""}
                      {set.primaryInvocationObserved !== undefined && (
                        <dl className="details">
                          <dt>Selected script</dt>
                          <dd>
                            {set.primaryInvocationObserved
                              ? `Exit ${set.primaryExitStatus ?? "pending"}`
                              : "Invocation not yet observed"}
                          </dd>
                          <dt>Surrounding shell</dt>
                          <dd>{set.shellExitStatus ?? "pending"}</dd>
                          <dt>Process scope</dt>
                          <dd>
                            {set.processScopeState ?? "UNCONFIRMED"}
                            {set.quiescentAt ? ` · ${set.quiescentAt}` : ""}
                          </dd>
                        </dl>
                      )}
                      {[set.stdout, set.stderr].filter(Boolean).map((log) => {
                        const artifact = value.artifacts?.find((a) =>
                          a.path.endsWith(`/output/${log}`)
                        );
                        return artifact ? (
                          <a key={log} href={artifact.url}>
                            {log!.endsWith("stdout") ? "Standard output" : "Standard error"}
                          </a>
                        ) : null;
                      })}
                    </li>
                  ))}
                </ol>
                {step.shutdown && (
                  <p>
                    Temporary shutdown: {step.shutdown.state} · exit{" "}
                    {step.shutdown.exitStatus ?? "unobserved"}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <details>
            <summary>Reviewed setup settings</summary>
            <DatabaseSetupSummary setup={value.configuration} />
          </details>
        </>
      )}
    </section>
  );
}
