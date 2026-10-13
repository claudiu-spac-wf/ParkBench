export const MAX_ARTIFACT_BYTES = 2_000_000_000;
export function assertArtifactSize(size: number): void {
  if (size > MAX_ARTIFACT_BYTES) throw new Error("artifact_size_limit_exceeded");
}

export const RAW_CHUNK_SECONDS = 300,
  RAW_RESPONSE_BYTES = 8 * 1024 * 1024,
  RAW_RESPONSE_SAMPLES = 100000,
  RAW_REQUEST_TIMEOUT_MS = 30000,
  SUMMARY_JOB_DEADLINE_MS = 120000,
  MAX_ACTIVE_SUMMARY_ROWS = 64,
  MAX_PERCENTILE_BINS = 4096;
