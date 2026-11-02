import React from "react";
import { databaseIopsPresentation } from "./database-iops-presentation";
export function DatabaseIopsSummary({ snapshot, runId }: { snapshot: any; runId?: string }) {
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
          {view.artifactId && runId && (
            <a
              href={`/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(view.artifactId)}`}
            >
              IOPS diagnostics
            </a>
          )}
        </>
      )}
    </section>
  );
}
