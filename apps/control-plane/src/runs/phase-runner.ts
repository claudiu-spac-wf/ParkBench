import type { NativeScrapeTiming } from "../../../../packages/metrics/src/prometheus-client";

export function phaseSchedule(
  phases: { warmupSeconds: number; measurementSeconds: number; cooldownSeconds: number },
  startMs: number,
  scale = 1,
  nativeScrape?: NativeScrapeTiming
) {
  let cursor = startMs;
  if (nativeScrape) {
    const { lastScrapeAtMs, cadenceMs } = nativeScrape;
    if (
      !Number.isSafeInteger(lastScrapeAtMs) ||
      lastScrapeAtMs < 0 ||
      !Number.isSafeInteger(cadenceMs) ||
      cadenceMs <= 0 ||
      cadenceMs > 120000 ||
      !Number.isFinite(startMs) ||
      lastScrapeAtMs > startMs
    )
      throw new Error("native_scrape_clock_invalid");
    // Place the measurement source origin just before the next actual scrape.
    // The entire adjacent schedule moves together; no phase or cadence changes.
    const leadMs = Math.min(250, cadenceMs / 20);
    const measurementReadyAtMs = startMs + Math.max(0, phases.warmupSeconds * 1000 * scale);
    const nextOrdinal = Math.ceil((measurementReadyAtMs + leadMs - lastScrapeAtMs) / cadenceMs);
    const measurementStartMs = lastScrapeAtMs + nextOrdinal * cadenceMs - leadMs;
    cursor += measurementStartMs - measurementReadyAtMs;
  }
  return (
    [
      ["warmup", phases.warmupSeconds],
      ["measurement", phases.measurementSeconds],
      ["cooldown", phases.cooldownSeconds]
    ] as const
  ).map(([phase, seconds]) => {
    const startMs = cursor;
    cursor += Math.max(0, seconds * 1000 * scale);
    return { phase, seconds, startMs, endMs: cursor };
  });
}

export async function runPhases(
  phases: { warmupSeconds: number; measurementSeconds: number; cooldownSeconds: number },
  onPhase: (phase: "warmup" | "measurement" | "cooldown") => Promise<void> | void,
  scale = Number(process.env.PARKBENCH_PHASE_SCALE ?? 1),
  sleepAfterPhase = true
): Promise<void> {
  for (const [phase, seconds] of [
    ["warmup", phases.warmupSeconds],
    ["measurement", phases.measurementSeconds],
    ["cooldown", phases.cooldownSeconds]
  ] as const) {
    await onPhase(phase);
    const delay = Math.min(60000, seconds * 1000 * scale);
    if (sleepAfterPhase && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
