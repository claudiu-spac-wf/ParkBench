export function phaseSchedule(
  phases: { warmupSeconds: number; measurementSeconds: number; cooldownSeconds: number },
  startMs: number,
  scale = 1
) {
  let cursor = startMs;
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
