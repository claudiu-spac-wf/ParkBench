import { RequestResult } from "./http-client";
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
export function buildSummary(input: {
  runId: string;
  startedAt: string;
  finishedAt: string;
  phaseDurationsSeconds: Record<string, number>;
  results: RequestResult[];
  shutdownReason: string;
}) {
  const measurementResults = input.results.filter(
    (result) => !result.phase || result.phase === "measurement"
  );
  const completeResults = measurementResults.filter(
    (result) => result.latencyObservation !== "lower_bound"
  );
  const timeoutResults = measurementResults.filter((result) => result.timeout);
  const phaseResults = Object.fromEntries(
    ["warmup", "measurement", "cooldown"].map((phase) => {
      const values = input.results.filter((result) => result.phase === phase);
      return [
        phase,
        {
          requests: values.length,
          failures: values.filter((result) => result.error).length,
          timeoutCount: values.filter((result) => result.timeout).length
        }
      ];
    })
  );
  const operations: Record<string, { completed: number; errors: number }> = {};
  for (const result of measurementResults) {
    operations[result.operation] ??= { completed: 0, errors: 0 };
    if (result.error) operations[result.operation].errors++;
    else operations[result.operation].completed++;
  }
  return {
    contractVersion: "loadgen.v1",
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    phaseDurationsSeconds: input.phaseDurationsSeconds,
    requests: {
      completed:
        measurementResults.length - measurementResults.filter((result) => result.error).length,
      errors: measurementResults.filter((result) => result.error).length
    },
    operations,
    latencySeconds: {
      count: completeResults.length,
      p50: percentile(
        completeResults.map((result) => result.durationSeconds),
        0.5
      ),
      p95: percentile(
        completeResults.map((result) => result.durationSeconds),
        0.95
      ),
      p99: percentile(
        completeResults.map((result) => result.durationSeconds),
        0.99
      )
    },
    timeoutCount: timeoutResults.length,
    timeoutMs: timeoutResults.find((result) => result.timeoutMs)?.timeoutMs ?? 0,
    timeoutObservations: timeoutResults.map((result) => ({
      requestId: result.requestId,
      operation: result.operation,
      elapsedMs: Math.round(result.durationSeconds * 1000),
      latencyObservation: "lower_bound"
    })),
    applicationErrorCount: measurementResults.filter((result) => result.error && !result.timeout)
      .length,
    shutdownReason: input.shutdownReason,
    thresholdFailed: input.results.some((result) => result.error?.startsWith("unexpected_status:")),
    phases: Object.fromEntries(
      [...new Set(input.results.map((result) => result.phase).filter(Boolean))].map((phase) => [
        phase,
        input.results.filter((result) => result.phase === phase).length
      ])
    ),
    phaseResults,
    errorSamples: input.results
      .filter((result) => result.error)
      .slice(0, 10)
      .map((result) => ({
        operation: result.operation,
        phase: result.phase,
        status: result.status,
        error: [result.error, result.errorDetail]
          .filter(Boolean)
          .join(":")
          .replaceAll(/\s+/g, " ")
          .slice(0, 256),
        timeout: Boolean(result.timeout)
      }))
  };
}
