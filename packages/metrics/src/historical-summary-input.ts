import type { Run } from "../../contracts/src/run";
import type { MetricSample } from "../../contracts/src/metrics";
import { resolveMeasurementWindow } from "./measurement-window";
/** Historical numeric work uses recorded boundaries and retained cumulative/gauge series. */
export function historicalSummaryInput(run: Run) {
  const window = resolveMeasurementWindow(run),
    snapshot = (run.environmentSnapshot as any) ?? {};
  if (
    window.state === "not_started" &&
    (["SUCCEEDED", "INCOMPLETE", "THRESHOLD_FAILED"].includes(run.state) ||
      (snapshot.metrics?.measurement?.state !== "not_started" &&
        snapshot.contextContractVersion !== "run-context.v1"))
  )
    throw new Error("legacy_semantics:measurement_boundaries_missing");
  return {
    run,
    window,
    cadenceSeconds:
      Number(
        snapshot.sourceCadences?.prometheusScrapeSeconds ?? snapshot.metrics?.stepSeconds ?? 5
      ) || 5,
    nativeProtocolVersion: String(snapshot.metricContracts?.nativeDb ?? "").includes("v3")
      ? (3 as const)
      : (2 as const)
  };
}
export function normalizeHistoricalPasAliases(samples: MetricSample[]): MetricSample[] {
  return samples.map((sample) => {
    if (!sample.metricName.startsWith("parkbench_openedge_pas_")) return sample;
    const raw = sample.labels.replica ?? sample.labels.service ?? "",
      match = raw.match(/^(?:pas[-_])?(\d+)$/);
    return match
      ? {
          ...sample,
          labels: {
            ...sample.labels,
            replica: `pas-${Number(match[1])}`,
            service: `pas-${Number(match[1])}`
          }
        }
      : sample;
  });
}
