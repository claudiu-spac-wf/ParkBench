import { scanSelectors } from "./promql-selectors";
import { RunTimeline } from "./run-timeline";

/** Continuous infrastructure series carry no phase label. Phase selection is a
 * time-window view; the source series and its scrape cadence stay unchanged. */
export function continuousPhaseQuery(expression: string, timeline: RunTimeline) {
  if (!timeline.continuousMetrics) return { expression, filter: (body: any) => body };
  const matchers = scanSelectors(expression).flatMap((s) =>
    s.matchers.filter((m) => m.name === "phase")
  );
  let rewritten = expression;
  for (const m of [...matchers].sort((a, b) => b.start - a.start)) {
    if (m.op !== "=" && m.op !== "=~") continue;
    const pattern = m.op === "=" ? m.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : m.value;
    rewritten =
      rewritten.slice(0, m.start) +
      `phase=~${JSON.stringify(`(${pattern})|^$`)}` +
      rewritten.slice(m.end);
  }
  const patterns = [...new Map(matchers.map((m) => [m.op + ":" + m.value, m])).values()];
  const matches = (phase: string) =>
    patterns.some((m) => {
      const equal =
        m.op === "=" || m.op === "!="
          ? phase === m.value
          : new RegExp(`^(?:${m.value})$`).test(phase);
      return m.op === "!=" || m.op === "!~" ? !equal : equal;
    });
  const unrestricted = !patterns.length || ["warmup", "measurement", "cooldown"].every(matches);
  return {
    expression: rewritten,
    filter(body: any) {
      if (unrestricted || !body?.data?.result) return body;
      const keep = (timestamp: number) =>
        timeline.phases.some(
          (span) =>
            matches(span.phase) &&
            timestamp * 1000 >= span.start &&
            timestamp * 1000 < (span.end ?? Infinity)
        );
      body.data.result = body.data.result.flatMap((series: any) => {
        if (Array.isArray(series.values)) {
          series.values = series.values.filter(([timestamp]) => keep(Number(timestamp)));
          return series.values.length ? [series] : [];
        }
        if (Array.isArray(series.value)) return keep(Number(series.value[0])) ? [series] : [];
        return [series];
      });
      return body;
    }
  };
}
