import { MetricLabels, MetricPhase } from "../../contracts/src/metrics";
const ALLOWED = new Set([
  "experiment_id",
  "run_id",
  "variant_id",
  "repetition",
  "component",
  "service",
  "phase",
  "operation",
  "device"
]);
export function buildRunLabels(
  input: Partial<MetricLabels> &
    Pick<
      MetricLabels,
      "experiment_id" | "run_id" | "variant_id" | "repetition" | "component" | "service" | "phase"
    >
): MetricLabels {
  const labels: MetricLabels = {
    experiment_id: input.experiment_id,
    run_id: input.run_id,
    variant_id: input.variant_id,
    repetition: String(input.repetition),
    component: input.component,
    service: input.service,
    phase: input.phase
  };
  for (const [key, value] of Object.entries(input))
    if (ALLOWED.has(key) && value !== undefined && key in labels === false)
      labels[key] = String(value);
  return labels;
}
export function phaseLabel(phase: string): MetricPhase {
  if (["warmup", "measurement", "cooldown", "idle"].includes(phase)) return phase as MetricPhase;
  throw new Error(`invalid_metric_phase:${phase}`);
}
export function serializeLabels(labels: Record<string, string | undefined>): string {
  return Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) => `${key}="${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    )
    .join(",");
}
