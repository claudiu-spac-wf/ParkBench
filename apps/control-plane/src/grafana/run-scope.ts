import { literalRunIds, PromqlScanError, scanSelectors, Selector } from "./promql-selectors";

export const RUN_LABEL = "run_id";

/** Synthetic series served from the run store, never from Prometheus. */
export const SYNTHETIC_METRICS = new Set([
  "parkbench_run_notice_text",
  "parkbench_db_diagnostic",
  "parkbench_saved_summary",
  "parkbench_parameter_snapshot_info",
  "parkbench_parameter_snapshot_numeric",
  "parkbench_parameter_snapshot_status",
  "parkbench_table_rank",
  "parkbench_run_phase_boundary",
  "parkbench_run_window",
  "parkbench_run_alignment_excluded",
  "parkbench_run_mode_mismatch"
]);

/**
 * Run-independent reference selectors that may appear inside a run-scoped query without a
 * run matcher (contract R1 exemption): the table tie-break rule and the host core count.
 */
export function isReferenceSelector(selector: Selector): boolean {
  if (selector.metric === "parkbench:table_tiebreak_bias") return selector.matchers.length === 0;
  if (selector.metric === "node_cpu_seconds_total") {
    const labels = new Map(selector.matchers.map((m) => [m.name, m]));
    return (
      selector.matchers.length === 2 &&
      labels.get("job")?.op === "=" &&
      labels.get("job")?.value === "node-exporter" &&
      labels.get("mode")?.op === "=" &&
      labels.get("mode")?.value === "idle"
    );
  }
  return false;
}

export type RunScope =
  | { kind: "constant" }
  | { kind: "synthetic"; metric: string; runIds?: string[]; matchers: Selector["matchers"] }
  | { kind: "scoped"; runIds: string[]; runMatchers: Array<{ start: number; end: number }> }
  | {
      kind: "error";
      errorClass: "run_matcher_required" | "run_matcher_mismatch" | "bad_query";
      message: string;
    };

/**
 * Classifies a data query: constant-only (R7), a single synthetic selector, or a run-scoped
 * query where every non-reference selector carries the same literal run matcher (R1).
 */
export function analyzeRunScope(expr: string): RunScope {
  let selectors: Selector[];
  try {
    selectors = scanSelectors(expr);
  } catch (error) {
    return {
      kind: "error",
      errorClass: "bad_query",
      message: error instanceof PromqlScanError ? error.message : String(error)
    };
  }
  if (!selectors.length) return { kind: "constant" };
  const synthetic = selectors.filter(
    (selector) => selector.metric && SYNTHETIC_METRICS.has(selector.metric)
  );
  if (synthetic.length) {
    if (selectors.length > 1 || synthetic.length > 1)
      return {
        kind: "error",
        errorClass: "bad_query",
        message: "synthetic_series_must_be_queried_alone"
      };
    const selector = synthetic[0];
    const runMatcher = selector.matchers.find((m) => m.name === RUN_LABEL);
    let runIds: string[] | undefined;
    if (
      [
        "parkbench_run_notice_text",
        "parkbench_db_diagnostic",
        "parkbench_table_rank",
        "parkbench_saved_summary",
        "parkbench_parameter_snapshot_info",
        "parkbench_parameter_snapshot_numeric",
        "parkbench_parameter_snapshot_status"
      ].includes(selector.metric ?? "") &&
      !runMatcher
    )
      return { kind: "error", errorClass: "run_matcher_required", message: "run_matcher_required" };
    if (runMatcher) {
      runIds = (runMatcher.op === "=" || runMatcher.op === "=~") && runMatcher.value === "" ? [] : literalRunIds(runMatcher);
      if (!runIds)
        return {
          kind: "error",
          errorClass: "run_matcher_required",
          message: "run_matcher_required"
        };
    }
    return { kind: "synthetic", metric: selector.metric!, runIds, matchers: selector.matchers };
  }
  let runIds: string[] | undefined;
  const runMatchers: Array<{ start: number; end: number }> = [];
  for (const selector of selectors) {
    if (isReferenceSelector(selector)) continue;
    const matcher = selector.matchers.find((m) => m.name === RUN_LABEL);
    const ids = matcher ? literalRunIds(matcher) : undefined;
    if (!matcher || !ids)
      return { kind: "error", errorClass: "run_matcher_required", message: "run_matcher_required" };
    const key = [...ids].sort().join("|");
    if (runIds && [...runIds].sort().join("|") !== key)
      return { kind: "error", errorClass: "run_matcher_mismatch", message: "run_matcher_mismatch" };
    runIds = ids;
    runMatchers.push({ start: matcher.start, end: matcher.end });
  }
  if (!runIds)
    return { kind: "error", errorClass: "run_matcher_required", message: "run_matcher_required" };
  return { kind: "scoped", runIds, runMatchers };
}

/** Rewrites every run matcher in `expr` to `run_id="<runId>"` (aligned per-run narrowing). */
export function narrowToRun(
  expr: string,
  runMatchers: Array<{ start: number; end: number }>,
  runId: string
): string {
  let output = expr;
  for (const span of [...runMatchers].sort((a, b) => b.start - a.start))
    output = `${output.slice(0, span.start)}${RUN_LABEL}="${runId}"${output.slice(span.end)}`;
  return output;
}
