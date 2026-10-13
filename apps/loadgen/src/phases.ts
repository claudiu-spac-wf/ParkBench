export type LoadPhase = "warmup" | "measurement" | "cooldown";
export async function phaseWindow(
  phase: LoadPhase,
  seconds: number,
  callback: (phase: LoadPhase) => Promise<void>,
  scale = Number(process.env.PARKBENCH_PHASE_SCALE ?? 1),
  wait = true
): Promise<void> {
  await callback(phase);
  const duration = Math.min(60000, seconds * 1000 * scale);
  if (wait && duration) await new Promise((resolve) => setTimeout(resolve, duration));
}
