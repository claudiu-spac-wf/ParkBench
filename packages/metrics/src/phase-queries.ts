import { MetricSample } from "../../contracts/src/metrics";
export function selectPhase(samples: MetricSample[], phase: string): MetricSample[] {
  return samples.filter((sample) => sample.labels.phase === phase);
}
export function measurementOnly(samples: MetricSample[]): MetricSample[] {
  return selectPhase(samples, "measurement");
}
