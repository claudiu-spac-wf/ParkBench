import React from "react";
import { databaseIopsPresentation } from "./database-iops-presentation";
export function DatabaseIopsSummary({ snapshot }: { snapshot: any; runId?: string }) {
  const view = databaseIopsPresentation(snapshot);
  const e = view.evidence;
  return (
    <section className="database-iops-summary" aria-label="Database disk IOPS">
      <h3>Database disk IOPS</h3>
      <p>{view.text}</p>
      {view.condition && (
        <>
          <small>
            Catalog: {view.condition.catalogVersion}. Ceilings are independent for each direction
            and device; actual performance depends on caches, hardware and other limits.
          </small>
          <p>
            Policy: {view.verification}
            {e?.deviceCount !== undefined
              ? ` · ${e.deviceCount} backing device${e.deviceCount === 1 ? "" : "s"}`
              : ""}
          </p>
          {e?.applicationTiming && (
            <p>
              Application timing:{" "}
              {e.applicationTiming === "AFTER_SETUP_BEFORE_DATABASE_STARTUP"
                ? "After preparation and all setup scripts; before benchmark database startup."
                : e.applicationTiming === "BEFORE_DATABASE_STARTUP"
                  ? "Before database startup, including native repair and setup."
                  : "After database preparation."}
            </p>
          )}
          {e && !e.applicationTiming && (
            <small>Application timing was not recorded in this historical evidence.</small>
          )}
          {e?.appliedAt && <small>Applied: {e.appliedAt}</small>}
          {e?.verification?.lastVerifiedAt && (
            <small>Last verified: {e.verification.lastVerifiedAt}</small>
          )}
          {e?.failure && (
            <p role="status">
              {e.failure.code}
              {e.failure.phase ? ` during ${e.failure.phase}` : ""}
            </p>
          )}
        </>
      )}
    </section>
  );
}
