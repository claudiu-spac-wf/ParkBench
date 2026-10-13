import { boundedResponseJson, sharedRawQueryScheduler, RawQueryOptions } from "./raw-query";
import {
  RAW_REQUEST_TIMEOUT_MS,
  RAW_CHUNK_SECONDS,
  RAW_RESPONSE_BYTES,
  RAW_RESPONSE_SAMPLES
} from "./limits";
import { MetricSample, MetricType } from "../../contracts/src/metrics";
import openEdgeDbMetricCatalog from "../../contracts/src/openedge-db-metric-catalog.json";
export interface PrometheusClient {
  queryRawRange?(
    selector: string,
    start: number,
    end: number,
    cadence: number,
    options?: RawQueryOptions
  ): Promise<MetricSample[]>;
  queryRange(query: string, start: number, end: number, step: number): Promise<MetricSample[]>;
  queryInstant(query: string): Promise<MetricSample[]>;
  health(): Promise<boolean>;
  waitForRunTargets?(
    runId: string,
    phase: string,
    services: string[],
    timeoutMs?: number
  ): Promise<void>;
}

export interface MetricSink {
  append(samples: MetricSample[]): void;
}

export interface MetricTextExporter {
  render(): string;
}

/**
 * Buffers controller-generated samples until Prometheus scrapes the control
 * plane. This keeps the production HTTP query client read-only while still
 * giving observer completeness evidence a real Prometheus source.
 */
export class PrometheusMetricBuffer implements MetricSink, MetricTextExporter {
  private readonly series = new Map<string, MetricSample>();

  append(samples: MetricSample[]): void {
    for (const sample of samples) {
      const key = `${sample.metricName}|${JSON.stringify(sample.labels)}`;
      this.series.set(key, { ...sample, labels: { ...sample.labels } });
    }
  }

  samples(): MetricSample[] {
    return [...this.series.values()];
  }

  render(): string {
    const samples = this.samples();
    const types = new Map<string, MetricType>();
    for (const sample of samples) {
      const base = histogramBase(
        sample.metricName,
        sample.type ?? inferMetricType(sample.metricName)
      );
      types.set(base, sample.type ?? metricType(sample));
    }
    const lines = [...types].map(([name, type]) => `# TYPE ${name} ${type}`);
    lines.push(
      ...samples.map((sample) => {
        const labels = Object.entries({ ...sample.labels, source: sample.source })
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}="${escapeLabel(String(value))}"`)
          .join(",");
        return `${sample.metricName}{${labels}} ${sample.value} ${Math.floor(sample.timestamp * 1000)}`;
      })
    );
    return `${lines.join("\n")}\n`;
  }
}
export class MemoryPrometheusClient implements PrometheusClient {
  constructor(
    public samples: MetricSample[] = [],
    public fail = false
  ) {}
  async health(): Promise<boolean> {
    return !this.fail;
  }
  append(samples: MetricSample[]): void {
    this.samples.push(...samples);
  }
  async queryInstant(query: string): Promise<MetricSample[]> {
    if (this.fail) throw new Error("prometheus_unavailable");
    return this.select(query);
  }
  async queryRange(
    query: string,
    start: number,
    end: number,
    _step: number
  ): Promise<MetricSample[]> {
    if (this.fail) throw new Error("prometheus_unavailable");
    return this.select(query).filter(
      (sample) => sample.timestamp >= start && sample.timestamp <= end
    );
  }
  async queryRawRange(
    selector: string,
    start: number,
    end: number,
    _cadence: number,
    options: RawQueryOptions = {}
  ): Promise<MetricSample[]> {
    if (this.fail) throw new Error("source_unavailable");
    return this.select(selector).filter(
      (s) =>
        s.timestamp >= start &&
        (s.timestamp < end ||
          (options.includeExactEnd && s.type === "counter" && s.timestamp === end))
    );
  }
  private select(query: string): MetricSample[] {
    const metric = query.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/)?.[1];
    const matchers = [
      ...query.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)(=~|!~|!=|=)"((?:\\.|[^"\\])*)"/g)
    ];
    return this.samples.filter(
      (sample) =>
        matchers.every(([, key, operator, encoded]) => {
          const value = JSON.parse('"' + encoded + '"'),
            actual = sample.labels[key] ?? "";
          if (operator === "=~" || operator === "!~") {
            const matches = new RegExp("^(?:" + value + ")$").test(actual);
            return operator === "=~" ? matches : !matches;
          }
          return operator === "=" ? actual === value : actual !== value;
        }) &&
        (!metric ||
          sample.metricName === metric ||
          sample.metricName === normalizeMetricName(metric))
    );
  }
}
export class HttpPrometheusClient implements PrometheusClient {
  async queryRawRange(
    selector: string,
    start: number,
    end: number,
    _cadence: number,
    options: RawQueryOptions = {}
  ): Promise<MetricSample[]> {
    if (
      !/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^\n]*\})?$/.test(selector) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    )
      throw new Error("summary_selector_invalid");
    const duration = Math.round((end - start) * 1000) + 1;
    return sharedRawQueryScheduler.run(
      async () => {
        const signal = options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(RAW_REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(RAW_REQUEST_TIMEOUT_MS);
        let payload: any;
        try {
          const response = await fetch(
            `${this.baseUrl}/api/v1/query?${new URLSearchParams({ query: `${selector}[${duration}ms]`, time: String(end) })}`,
            { signal }
          );
          payload = await boundedResponseJson(response, signal);
        } catch (error) {
          if (signal.aborted && !options.signal?.aborted) throw new Error("query_timeout");
          throw error;
        }
        return parsePrometheusResponse(payload, true).filter(
          (s) =>
            Number.isFinite(s.value) &&
            Number.isFinite(s.timestamp) &&
            s.timestamp >= start &&
            (s.timestamp < end ||
              (options.includeExactEnd && s.type === "counter" && s.timestamp === end))
        );
      },
      options.priority,
      options.signal
    );
  }

  constructor(public readonly baseUrl: string) {}
  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/-/ready`, {
        signal: AbortSignal.timeout(5000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  async queryInstant(query: string): Promise<MetricSample[]> {
    return sharedRawQueryScheduler.run(async () => {
      const signal = AbortSignal.timeout(RAW_REQUEST_TIMEOUT_MS);
      const response = await fetch(
        `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`,
        { signal }
      );
      return parsePrometheusResponse(await boundedResponseJson(response, signal, true));
    });
  }
  async waitForRunTargets(
    runId: string,
    phase: string,
    services: string[],
    timeoutMs = 10000
  ): Promise<void> {
    // Callers size the wait from the scrape interval (three intervals plus slack), so a 15 s
    // interval needs about 50 s. The bound only stops a misconfigured interval from hanging a run.
    const boundedTimeout = Math.max(250, Math.min(120_000, timeoutMs));
    const deadline = Date.now() + boundedTimeout;
    const escapedRunId = escapePrometheusString(runId);
    const escapedPhase = escapePrometheusString(phase);
    const missing = new Set(services);
    let lastError = "";
    do {
      try {
        const targets = await this.queryInstant(
          `up{run_id="${escapedRunId}"${phase ? `,phase="${escapedPhase}"` : ""}}`
        );
        for (const target of targets) {
          if (target.value === 1 && target.labels.service) missing.delete(target.labels.service);
        }
        if (missing.size === 0) return;
      } catch (error) {
        lastError = String(error).replaceAll(/\s+/g, " ").slice(0, 300);
      }
      if (Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new Error(
      `prometheus_run_targets_not_ready:${runId}:${phase}:${[...missing].sort().join(",")}${lastError ? `:${lastError}` : ""}`
    );
  }
  async queryRange(
    query: string,
    start: number,
    end: number,
    step: number
  ): Promise<MetricSample[]> {
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start ||
      !Number.isFinite(step) ||
      step <= 0
    )
      throw new Error("measurement_window_invalid");
    const result: MetricSample[] = [];
    let bytes = 0;
    const signal = AbortSignal.timeout(120000);
    const append = async (a: number, b: number) => {
      let samples: MetricSample[];
      try {
        samples = await sharedRawQueryScheduler.run(
          async () => {
            const requestSignal = AbortSignal.any([
              signal,
              AbortSignal.timeout(RAW_REQUEST_TIMEOUT_MS)
            ]);
            const params = new URLSearchParams({
              query,
              start: String(a),
              end: String(b),
              step: String(step)
            });
            const response = await fetch(`${this.baseUrl}/api/v1/query_range?${params}`, {
              signal: requestSignal
            });
            return parsePrometheusResponse(await boundedResponseJson(response, requestSignal));
          },
          "historical",
          signal
        );
      } catch (error) {
        if (String(error).includes("summary_limit_exceeded") && b - a > step) {
          const mid = a + Math.floor((b - a) / (2 * step)) * step;
          await append(a, mid);
          await append(mid + step, b);
          return;
        }
        throw error;
      }
      bytes += Buffer.byteLength(JSON.stringify(samples), "utf8");
      if (result.length + samples.length > RAW_RESPONSE_SAMPLES || bytes > RAW_RESPONSE_BYTES)
        throw new Error("summary_limit_exceeded:range_result");
      result.push(...samples);
    };
    const span = Math.floor(RAW_CHUNK_SECONDS / step) * step;
    for (let a = start; a <= end; a += span + step) await append(a, Math.min(end, a + span));
    return result;
  }
}

function escapePrometheusString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}
export function parsePrometheusResponse(payload: any, preserveRawNames = false): MetricSample[] {
  const data = payload?.data?.result ?? [];
  return data.flatMap((series: any) => {
    // Raw measurement reads retain source labels, including Docker ownership provenance.
    // Legacy query-grid consumers continue to receive canonicalized labels.
    const labels = preserveRawNames
      ? { ...series.metric }
      : normalizePrometheusLabels({ ...series.metric });
    const metricName = preserveRawNames
      ? (labels.__name__ ?? "unknown")
      : normalizeMetricName(labels.__name__ ?? "unknown");
    const source = sourceForMetric(labels, metricName);
    delete labels.__name__;
    const values = series.values ?? (series.value ? [series.value] : []);
    return values.map((pair: [number | string, string | number]) => ({
      metricName,
      type: inferMetricType(metricName),
      labels,
      timestamp: Number(pair[0]),
      value: Number(pair[1]),
      source
    }));
  });
}

/** Keep only cAdvisor samples that are owned by the current run. */
export function filterCAdvisorMetrics(body: string, activeRunId?: string): string {
  if (!activeRunId) return "\n";
  const escapedRunId = activeRunId ? activeRunId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : undefined;
  const managed = /(?:^|,)container_label_parkbench_managed="true"(?:,|})/;
  const run = escapedRunId
    ? new RegExp(`(?:^|,)container_label_parkbench_run_id="${escapedRunId}"(?:,|})`)
    : undefined;
  return body
    .split(/\r?\n/)
    .filter((line) => {
      if (!line || line.startsWith("#")) return false;
      const labels = line.match(/\{([^}]*)\}/)?.[1];
      if (!labels || !managed.test(labels)) return false;
      return run ? run.test(labels) : true;
    })
    .join("\n")
    .concat("\n");
}

function normalizePrometheusLabels(labels: Record<string, string>): Record<string, string> {
  for (const [key, value] of Object.entries(labels)) {
    if (!key.startsWith("container_label_parkbench_")) continue;
    const canonical = key.slice("container_label_parkbench_".length);
    labels[canonical] = value;
    delete labels[key];
  }
  if (
    labels.container_label_com_docker_compose_service &&
    ["cadvisor", "node-exporter"].includes(labels.service ?? "")
  )
    labels.service = labels.container_label_com_docker_compose_service;
  if (!labels.service && labels.container_label_com_docker_compose_service)
    labels.service = labels.container_label_com_docker_compose_service;
  if (!labels.component && labels.service) labels.component = labels.service;
  return labels;
}

const METRIC_NAMES: Record<string, string> = {
  container_fs_reads_bytes_total: "parkbench_container_disk_read_bytes_total",
  container_fs_writes_bytes_total: "parkbench_container_disk_write_bytes_total",
  container_fs_reads_total: "parkbench_container_disk_read_operations_total",
  container_fs_writes_total: "parkbench_container_disk_write_operations_total",
  container_fs_io_time_seconds_total: "parkbench_container_disk_io_time_seconds_total",
  container_cpu_usage_seconds_total: "parkbench_container_cpu_usage_seconds_total",
  container_memory_working_set_bytes: "parkbench_container_memory_working_set_bytes",
  container_network_receive_bytes_total: "parkbench_container_network_receive_bytes_total",
  container_network_transmit_bytes_total: "parkbench_container_network_transmit_bytes_total",
  node_disk_read_bytes_total: "parkbench_host_disk_read_bytes_total",
  node_disk_written_bytes_total: "parkbench_host_disk_write_bytes_total",
  node_disk_reads_completed_total: "parkbench_host_disk_read_operations_total",
  node_disk_writes_completed_total: "parkbench_host_disk_write_operations_total",
  node_disk_io_time_seconds_total: "parkbench_host_disk_io_time_seconds_total",
  node_memory_MemAvailable_bytes: "parkbench_host_memory_available_bytes",
  node_filesystem_avail_bytes: "parkbench_host_filesystem_available_bytes"
};

export function normalizeMetricName(name: string): string {
  return METRIC_NAMES[name] ?? name;
}

export function inferMetricType(metricName: string): "counter" | "gauge" | "histogram" {
  const openEdgeSuffix = metricName.replace(/^parkbench_openedge_db_/, "");
  const openEdgeMetric = openEdgeDbMetricCatalog.entries.find(
    (metric) => metric.name === openEdgeSuffix
  );
  if (openEdgeMetric) return openEdgeMetric.type as "counter" | "gauge";
  if (/^parkbench_workload_request_duration_seconds_(bucket|count|sum)$/.test(metricName))
    return "histogram";
  return metricName.endsWith("_total") || metricName.endsWith("_seconds_total")
    ? "counter"
    : "gauge";
}

function sourceForMetric(labels: Record<string, string>, metricName: string): string {
  if (labels.source) return labels.source;
  if (metricName.startsWith("parkbench_container_")) return "cadvisor";
  if (metricName.startsWith("parkbench_host_disk_")) return "node-exporter:block-device";
  if (metricName.startsWith("parkbench_host_")) return "node-exporter";
  if (metricName.startsWith("parkbench_file_")) return "file-sampler";
  if (metricName.startsWith("parkbench_workload_")) return "loadgen";
  if (metricName.startsWith("parkbench_openedge_db_")) {
    const suffix = labels.measurement ?? metricName.slice("parkbench_openedge_db_".length);
    const metric = openEdgeDbMetricCatalog.entries.find((candidate) => candidate.name === suffix);
    return metric?.sources[0] ?? "openedge-vst";
  }
  if (metricName.startsWith("parkbench_openedge_pas_")) return "pas-management";
  return labels.job ?? "prometheus";
}

function histogramBase(metricName: string, type: MetricType): string {
  if (type === "histogram") return metricName.replace(/_(bucket|count|sum)$/, "");
  return metricName;
}

function metricType(sample: MetricSample): MetricType {
  return sample.metricName.endsWith("_total") ? "counter" : "gauge";
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}
