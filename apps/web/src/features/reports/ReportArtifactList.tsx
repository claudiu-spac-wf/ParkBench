import React, { useState } from "react";
import { ReportArtifact } from "../../../../../packages/contracts/src/database-analysis-report";
import { reportArtifactDownloadUrl } from "./reportArtifactDownloadUrl";
export function ReportArtifactList({
  reportId,
  artifacts
}: {
  reportId: string;
  artifacts: ReportArtifact[];
}) {
  const [errors, setErrors] = useState({} as Record<string, string>);
  async function download(a: ReportArtifact, e: React.MouseEvent) {
    e.preventDefault();
    try {
      const url = reportArtifactDownloadUrl(reportId, a.id),
        response = await fetch(url, { method: "HEAD" });
      if (!response.ok)
        throw new Error(
          response.status === 410
            ? "This retained file is missing."
            : "This file cannot be downloaded (" + response.status + ")."
        );
      setErrors((v) => ({ ...v, [a.id]: "" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = a.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      setErrors((v) => ({ ...v, [a.id]: (error as Error).message }));
    }
  }
  return (
    <section className="report-panel">
      <h2>Retained files</h2>
      <p>
        Download full dataset includes every retained row, independent of view filters. Known
        measurements carry units in CSV headers; unknown fields say [unit unknown].
      </p>
      {!artifacts.length ? (
        <p>No files retained yet.</p>
      ) : (
        <ul className="report-artifacts">
          {artifacts.map((a) => (
            <li key={a.id}>
              <a href={reportArtifactDownloadUrl(reportId, a.id)} onClick={(e) => download(a, e)}>
                {a.kind === "CSV" ? "Download full dataset" : "Download " + a.kind.toLowerCase()}:{" "}
                {a.filename}
              </a>{" "}
              <span>
                {a.datasetKind} · {a.complete ? "Complete" : "Incomplete evidence"} · {a.byteLength}{" "}
                bytes
              </span>
              {errors[a.id] && (
                <p role="alert">
                  {errors[a.id]} Retry this file using its download link. Other files remain
                  available.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
