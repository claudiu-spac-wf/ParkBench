export function reportArtifactDownloadUrl(reportId: string, artifactId: string) {
  return `/api/v1/reports/${encodeURIComponent(reportId)}/artifacts/${encodeURIComponent(artifactId)}`;
}
