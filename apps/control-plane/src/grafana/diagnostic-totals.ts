import { counterWindow } from "./native-counter-window";
import { recordChartDecision } from "../measurement-diagnostics/chart-evidence";

export type DiagnosticTotal = {
  value: number | null;
  coverage: "complete" | "partial" | "unavailable";
};
export const TOTAL_COVERAGE_LABELS = ["coverage_status", "coverage_note"];
export function totalCoverageLabels(coverage: DiagnosticTotal["coverage"]) {
  return {
    coverage_status: coverage,
    coverage_note: coverage === "complete" ? "" : ` [${coverage}]`
  };
}

/** Display arithmetic only. Missing contributions are never supplied as zeros. */
export function sumDiagnosticTotals(
  parts: Array<{ value: unknown; coverage?: string }>
): DiagnosticTotal {
  let value = 0,
    supported = 0,
    partial = false;
  for (const part of parts) {
    if (part.value === null || part.value === undefined || part.value === "NaN") {
      partial = true;
      continue;
    }
    const number =
      typeof part.value === "number" || (typeof part.value === "string" && part.value.trim())
        ? Number(part.value)
        : NaN;
    if (!Number.isFinite(number) || number < 0) return { value: null, coverage: "unavailable" };
    value += number;
    supported++;
    partial ||= part.coverage === "partial" || part.coverage === "unavailable";
  }
  return supported && Number.isFinite(value)
    ? { value, coverage: partial ? "partial" : "complete" }
    : { value: null, coverage: "unavailable" };
}

/** Preserve complete-window semantics. A partial total counts only supported
 * adjacent observations, without bridging gaps/nulls or extrapolating edges.
 * Callers supply exactly one phase window, publisher, instance and epoch. */
export function diagnosticCounterTotal(
  points: Array<[number, number | null]>,
  start: number,
  end: number,
  cadence: number,
  includeStart = false,
  check: () => void = () => {}
): DiagnosticTotal {
  const complete = counterWindow(points, start, end, cadence, includeStart);
  if (complete) return { value: complete.increase, coverage: "complete" };
  const observed = observedCounterIntervals(points, start, end, cadence, check);
  return { value: observed.value, coverage: observed.value === null ? "unavailable" : "partial" };
}

/** Instant diagnostic tables can use the supported part of their lookback.
 * Time-series rates continue to use strict counterWindow and retain gaps. */
export function diagnosticCounterRate(
  points: Array<[number, number | null]>,
  start: number,
  end: number,
  cadence: number,
  check: () => void = () => {}
): DiagnosticTotal {
  const complete = counterWindow(points, start, end, cadence);
  if (complete) return { value: complete.rate, coverage: "complete" };
  const observed = observedCounterIntervals(points, start, end, cadence, check);
  return observed.value !== null && observed.seconds > 0
    ? { value: observed.value / observed.seconds, coverage: "partial" }
    : { value: null, coverage: "unavailable" };
}

function observedCounterIntervals(
  points: Array<[number, number | null]>,
  start: number,
  end: number,
  cadence: number,
  check: () => void
): { value: number | null; seconds: number } {
  if (![start, end, cadence].every(Number.isFinite) || end <= start || cadence <= 0)
    return { value: null, seconds: 0 };
  let previous: [number, number] | undefined,
    value = 0,
    intervals = 0,
    observedSeconds = 0;
  for (const [time, current] of points) {
    check();
    if (time < start || time > end) continue;
    if (!Number.isFinite(time) || current === null || !Number.isFinite(current) || current < 0) {
      previous = undefined;
      continue;
    }
    if (previous && time > previous[0] && time - previous[0] <= cadence * 1.5) {
      value += current >= previous[1] ? current - previous[1] : current;
      observedSeconds += time - previous[0];
      intervals++;
    }
    previous = [time, current];
  }
  const supported = intervals > 0 && Number.isFinite(value);
  recordChartDecision({
    stage: "NATIVE_COUNTER",
    outcome: supported ? "SUCCEEDED" : "UNAVAILABLE",
    effectiveStartMs: start * 1000,
    effectiveEndMs: end * 1000,
    cadenceMs: cadence * 1000,
    counts: {
      observedIntervals: intervals,
      observedSeconds,
      omittedSeconds: Math.max(0, end - start - observedSeconds)
    },
    reasonCodes: [
      supported ? "diagnostic_partial_observed_intervals" : "diagnostic_no_supported_interval",
      "no_gap_bridge_or_edge_extrapolation"
    ]
  });
  return { value: supported ? value : null, seconds: observedSeconds };
}
