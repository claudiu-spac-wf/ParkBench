export function runSelector(runId: string): string {
  return `{run_id="${escapeLabel(runId)}"}`;
}
export function phaseQuery(metric: string, runId: string, phase?: string): string {
  return `${metric}${phase ? `{run_id="${escapeLabel(runId)}",phase="${escapeLabel(phase)}"}` : runSelector(runId)}`;
}
export function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}
