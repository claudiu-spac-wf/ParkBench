/** Execution evidence takes precedence over settings captured while queued.
 * Never infer acquisition cadence from observed gaps or the current platform. */
export function recordedPrometheusCadenceSeconds(snapshot: unknown): number | undefined {
  const environment = snapshot as {
    sourceCadences?: { prometheusScrapeSeconds?: number };
    nativeScrapeAlignment?: { contractVersion?: string; cadenceMs?: number };
  } | undefined;
  const alignment = environment?.nativeScrapeAlignment;
  if (
    alignment?.contractVersion === "native-scrape-alignment.v1" &&
    typeof alignment.cadenceMs === "number" &&
    Number.isFinite(alignment.cadenceMs) &&
    alignment.cadenceMs > 0
  ) return alignment.cadenceMs / 1000;
  return environment?.sourceCadences?.prometheusScrapeSeconds;
}
