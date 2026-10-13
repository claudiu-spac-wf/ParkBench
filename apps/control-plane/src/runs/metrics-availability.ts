import type { PrometheusClient } from "../../../../packages/metrics/src/prometheus-client";
import { readRawChunks } from "../../../../packages/metrics/src/raw-query";
import { TERMINAL_STATES } from "../../../../packages/contracts/src/run-state";
import type { Repositories } from "../db/repositories";

export type MetricsAvailability = "available" | "expired" | "unavailable" | "not_started";
function retentionMs(value: string): number {
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000,
    y: 31536000000
  };
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g)];
  return parts.map((m) => m[0]).join("") === value
    ? parts.reduce((sum, m) => sum + Number(m[1]) * units[m[2]], 0)
    : Infinity;
}

/** Probe recorded, bounded evidence windows, never today's instant view of a historical run. */
export class RunMetricsAvailability {
  private cache = new Map<string, { until: number; value: Promise<MetricsAvailability> }>();
  constructor(
    private repositories: Repositories,
    private client: PrometheusClient,
    private retention: string,
    private now = () => Date.now()
  ) {}
  async forRuns(ids: string[]): Promise<Record<string, MetricsAvailability>> {
    return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await this.get(id)])));
  }
  get(id: string): Promise<MetricsAvailability> {
    const prior = this.cache.get(id);
    if (prior && prior.until > this.now()) return prior.value;
    const value = this.probe(id);
    this.cache.delete(id);
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, { until: this.now() + 5000, value });
    value.catch(() => this.cache.delete(id));
    return value;
  }
  private async probe(id: string): Promise<MetricsAvailability> {
    const run = this.repositories.getRun(id);
    if (!run || !TERMINAL_STATES.includes(run.state)) return "available";
    const header = this.repositories.getSummaryCache(id)?.header;
    const window = header?.windows.measurement;
    if (window?.state === "not_started") return "not_started";
    const recorded = header?.metricsReference.queries.find(
      (q) => q.purpose === "required_source_verification" && q.observed
    );
    const numeric =
      header &&
      this.repositories
        .pageSummaryRows(id, { limit: 100 })
        .rows.find(
          (r) =>
            r.group !== "platform" &&
            r.statistics.average?.value != null &&
            r.sourceReferences.length
        );
    const start = recorded?.start ?? (window?.start ? Date.parse(window.start) / 1000 : NaN);
    const end = recorded?.end ?? (window?.end ? Date.parse(window.end) / 1000 : NaN);
    const name = numeric?.sourceReferences[0]?.metric;
    const selector =
      recorded?.selector ?? (name ? `${name}{run_id=${JSON.stringify(id)}}` : undefined);
    if (!selector || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return Number(run.summary?.sampleCount ?? 0) > 0 &&
        run.finishedAt &&
        Date.parse(run.finishedAt) < this.now() - retentionMs(this.retention)
        ? "expired"
        : "available";
    }
    for await (const chunk of readRawChunks(
      this.client,
      selector,
      start,
      end,
      header?.sampling.baseStepSeconds ?? 5
    ))
      if (chunk.samples.length) return "available";
    const measurementEnd = window?.end ? Date.parse(window.end) : end * 1000;
    return measurementEnd < this.now() - retentionMs(this.retention) ? "expired" : "unavailable";
  }
}
