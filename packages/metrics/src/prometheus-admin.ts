import type { MetricSample } from "../../contracts/src/metrics";
import { MemoryPrometheusClient } from "./prometheus-client";
export interface ExperimentMetricAdmin {
  preflight(): Promise<void>;
  inventory(
    experimentId: string,
    runIds: string[],
    options?: { runScope?: boolean }
  ): Promise<string[]>;
  delete(selectors: string[]): Promise<void>;
  verify(selectors: string[], windows?: { start?: number; end?: number }): Promise<void>;
  quiesce(runIds: string[]): Promise<void>;
}
const identity = (s: string) => {
  if (!/^[a-zA-Z0-9_.:-]{1,256}$/.test(s)) throw new Error("experiment_metric_identity_invalid");
  return JSON.stringify(s);
};
export function ownedMetricSelectors(
  experimentId: string,
  runIds: string[],
  series: Record<string, string>[] = [],
  options: { runScope?: boolean } = {}
): string[] {
  identity(experimentId);
  runIds.forEach(identity);
  const ids = new Set(runIds),
    out = new Set<string>();
  const add = (field: string, id: string, revisionField: string, revision: string) => {
    if (revision) identity(revision);
    const aggregate =
      options.runScope && field.endsWith("experiment_id")
        ? 'run_id="",container_label_parkbench_run_id="",'
        : "";
    out.add(`{${field}=${identity(id)},${aggregate}${revisionField}=${JSON.stringify(revision)}}`);
  };
  for (const id of ids) {
    add("run_id", id, "execution_revision", "");
    add("container_label_parkbench_run_id", id, "container_label_parkbench_execution_revision", "");
  }
  add("experiment_id", experimentId, "execution_revision", "");
  add(
    "container_label_parkbench_experiment_id",
    experimentId,
    "container_label_parkbench_execution_revision",
    ""
  );
  for (const labels of series) {
    if (ids.has(labels.run_id))
      add("run_id", labels.run_id, "execution_revision", labels.execution_revision ?? "");
    if (ids.has(labels.container_label_parkbench_run_id))
      add(
        "container_label_parkbench_run_id",
        labels.container_label_parkbench_run_id,
        "container_label_parkbench_execution_revision",
        labels.container_label_parkbench_execution_revision ?? ""
      );
    if (labels.experiment_id === experimentId)
      add("experiment_id", experimentId, "execution_revision", labels.execution_revision ?? "");
    if (labels.container_label_parkbench_experiment_id === experimentId)
      add(
        "container_label_parkbench_experiment_id",
        experimentId,
        "container_label_parkbench_execution_revision",
        labels.container_label_parkbench_execution_revision ?? ""
      );
  }
  return [...out].sort();
}
function matches(labels: Record<string, string | undefined>, selector: string): boolean {
  const parts = [...selector.matchAll(/([a-z_]+)=("(?:[^"\\]|\\.)*")/g)];
  return (
    parts.length > 0 && parts.every(([, key, value]) => (labels[key] ?? "") === JSON.parse(value))
  );
}
export class MemoryExperimentMetricAdmin implements ExperimentMetricAdmin {
  constructor(readonly client: MemoryPrometheusClient) {}
  async preflight() {}
  async inventory(experiment: string, runs: string[], options: { runScope?: boolean } = {}) {
    return ownedMetricSelectors(
      experiment,
      runs,
      this.client.samples.map((s) => s.labels as Record<string, string>),
      options
    );
  }
  async delete(selectors: string[]) {
    this.client.samples = this.client.samples.filter(
      (s) => !selectors.some((x) => matches(s.labels, x))
    );
  }
  async verify(selectors: string[]) {
    if (this.client.samples.some((s) => selectors.some((x) => matches(s.labels, x))))
      throw new Error("experiment_metrics_remain");
  }
  async quiesce(_runs: string[]) {}
}
export class HttpExperimentMetricAdmin implements ExperimentMetricAdmin {
  constructor(
    readonly baseUrl: string,
    readonly retentionSeconds = 365 * 86400,
    private readonly fetcher: typeof fetch = fetch,
    private readonly storageBounds?: () => Promise<{
      start?: number;
      end?: number;
      hostname?: string;
    }>
  ) {}
  private async request(route: string, parameters?: URLSearchParams): Promise<any> {
    const response = await this.fetcher(this.baseUrl.replace(/\/$/, "") + route, {
      method: parameters ? "POST" : "GET",
      body: parameters,
      headers: parameters ? { "Content-Type": "application/x-www-form-urlencoded" } : {},
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok)
      throw new Error(
        route.includes("delete_series")
          ? "experiment_metrics_delete_failed"
          : "experiment_metrics_deletion_unavailable"
      );
    if (response.status === 204) return undefined;
    if (!response.body) throw new Error("experiment_metrics_deletion_unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024) throw new Error("experiment_metric_inventory_too_large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.warnings?.length) throw Error("experiment_metric_inventory_incomplete");
    if (body.status !== "success") throw new Error("experiment_metrics_deletion_unavailable");
    return body.data;
  }
  async preflight(): Promise<void> {
    const flags = await this.request("/api/v1/status/flags");
    if (flags?.["web.enable-admin-api"] !== "true")
      throw new Error("experiment_metrics_deletion_unavailable");
    const rules = await this.request("/api/v1/rules?type=record");
    if (!Array.isArray(rules?.groups)) throw new Error("experiment_metrics_deletion_unavailable");
    if (rules.groups.some((g: any) => (g.rules ?? []).some((r: any) => r.type === "recording")))
      throw new Error("experiment_recording_rule_quiescence_unavailable");
    if (!this.storageBounds) throw Error("experiment_metric_storage_bounds_unavailable");
    const bounds = await this.storageBounds();
    if (bounds.hostname) {
      const runtime = await this.request("/api/v1/status/runtimeinfo");
      if (runtime?.hostname !== bounds.hostname)
        throw Error("experiment_metric_storage_bounds_unavailable");
    }
  }
  async inventory(
    experiment: string,
    runs: string[],
    options: { runScope?: boolean } = {}
  ): Promise<string[]> {
    const selectors = new Set(ownedMetricSelectors(experiment, runs, [], options));
    const scopes = [
      ...runs.flatMap((id) => [
        { field: "run_id", id, revision: "execution_revision" },
        {
          field: "container_label_parkbench_run_id",
          id,
          revision: "container_label_parkbench_execution_revision"
        }
      ]),
      { field: "experiment_id", id: experiment, revision: "execution_revision" },
      {
        field: "container_label_parkbench_experiment_id",
        id: experiment,
        revision: "container_label_parkbench_execution_revision"
      }
    ];
    // Distinct revision values avoid materializing a potentially huge series-label inventory.
    // Metadata is only scope discovery; sample counts below establish actual absence.
    for (const scope of scopes) {
      const aggregate =
        options.runScope && scope.field.endsWith("experiment_id")
          ? ',run_id="",container_label_parkbench_run_id=""'
          : "";
      const match = `{${scope.field}=${identity(scope.id)}${aggregate}}`;
      const values = await this.request(
        `/api/v1/label/${scope.revision}/values?` + new URLSearchParams({ "match[]": match })
      );
      if (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
        throw Error("experiment_metric_inventory_incomplete");
      for (const revision of values)
        selectors.add(
          `{${scope.field}=${identity(scope.id)}${aggregate},${scope.revision}=${revision ? identity(revision) : '""'}}`
        );
    }
    return [...selectors].sort();
  }
  async delete(selectors: string[]): Promise<void> {
    for (let i = 0; i < selectors.length; i += 32) {
      const params = new URLSearchParams();
      selectors.slice(i, i + 32).forEach((s) => params.append("match[]", s));
      await this.request("/api/v1/admin/tsdb/delete_series", params);
    }
  }
  async verify(selectors: string[], windows: { start?: number; end?: number } = {}): Promise<void> {
    // Raw range-vector counts cover sparse observations; query_range grids cannot prove absence.
    const stats = await this.request("/api/v1/status/tsdb");
    const blocks = (await this.storageBounds?.()) ?? {};
    if (
      !stats?.headStats ||
      !Number.isSafeInteger(stats.headStats.numSeries) ||
      stats.headStats.numSeries < 0
    )
      throw Error("experiment_metrics_verification_unavailable");
    const hasHead = stats.headStats.numSeries > 0;
    if (
      hasHead &&
      (!Number.isFinite(stats.headStats.minTime) || !Number.isFinite(stats.headStats.maxTime))
    )
      throw Error("experiment_metrics_verification_unavailable");
    const end =
      Math.max(
        Date.now() / 1000,
        hasHead ? stats.headStats.maxTime / 1000 : 0,
        windows.end ?? 0,
        blocks.end ?? 0
      ) + 1;
    const start =
      Math.min(
        this.storageBounds ? end : end - this.retentionSeconds,
        hasHead ? stats.headStats.minTime / 1000 : end,
        windows.start ?? end,
        blocks.start ?? end
      ) - 1;
    for (let t = start; t < end; t += 86400) {
      const right = Math.min(end, t + 86400),
        seconds = Math.ceil(right - t) + 1;
      for (let i = 0; i < selectors.length; i += 8) {
        const query = selectors
          .slice(i, i + 8)
          .map((s) => `(sum(count_over_time(${s}[${seconds}s])) or vector(0))`)
          .join(" + ");
        const result = await this.request(
          "/api/v1/query",
          new URLSearchParams({ query, time: String(right) })
        );
        if (result?.resultType !== "vector" || !Array.isArray(result.result))
          throw new Error("experiment_metrics_verification_unavailable");
        if (result.result.some((r: any) => Number(r.value?.[1]) !== 0))
          throw new Error("experiment_metrics_remain");
      }
    }
  }
  async quiesce(runIds: string[]): Promise<void> {
    const deadline = Date.now() + 120000;
    let clearSince = 0;
    while (Date.now() < deadline) {
      const targets = await this.request("/api/v1/targets?state=active");
      if (!Array.isArray(targets?.activeTargets))
        throw new Error("experiment_quiescence_unconfirmed");
      const owned = targets.activeTargets.filter((t: any) => runIds.includes(t.labels?.run_id));
      const config = await this.request("/api/v1/status/config");
      const timeout = Math.max(
        10000,
        ...[...String(config?.yaml ?? "").matchAll(/scrape_timeout:\s*([\d.]+)(ms|s|m)/g)].map(
          (m) => Number(m[1]) * (m[2] === "m" ? 60000 : m[2] === "s" ? 1000 : 1)
        )
      );
      if (owned.length) clearSince = 0;
      else if (!clearSince) clearSince = Date.now();
      if (clearSince && Date.now() - clearSince > timeout + 2000) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("experiment_quiescence_unconfirmed");
  }
}
