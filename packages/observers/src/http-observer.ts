import { validateOpenEdgeDbLatchInventory } from "../../contracts/src/openedge";
import { MetricSample, MetricType } from "../../contracts/src/metrics";
import { ObserverAdapter, ObserverContext, observerLabels } from "./adapter";

export class HttpMetricsObserver implements ObserverAdapter {
  constructor(
    public readonly id: string,
    public readonly kind: string,
    private readonly baseUrl: string,
    private readonly metricsPath = "/metrics",
    private readonly timeoutMs = 3000,
    private readonly declaredMetrics: string[] = []
  ) {}

  async ready(): Promise<boolean> {
    let response: Response;
    try {
      response = await requestWithRetry(`${this.baseUrl}/health`, this.timeoutMs);
    } catch {
      throw new Error("observer_health_unreachable");
    }
    if (!response.ok) throw new Error(`observer_health_failed:${response.status}`);

    let metrics: Response;
    try {
      metrics = await requestWithRetry(`${this.baseUrl}${this.metricsPath}`, this.timeoutMs);
    } catch {
      throw new Error("observer_metrics_unreachable");
    }
    if (!metrics.ok) throw new Error(`observer_metrics_failed:${metrics.status}`);

    let samples: MetricSample[];
    try {
      samples = parsePrometheusTextWithDiagnostics(
        await metrics.text(),
        {
          runId: "observer-readiness",
          experimentId: "observer-readiness",
          variantId: "observer-readiness",
          repetition: 1,
          phase: "measurement"
        },
        this.id
      ).samples;
    } catch {
      throw new Error("observer_metrics_unparseable");
    }
    if (!samples.length) throw new Error("observer_metrics_empty");
    return true;
  }

  async latchInventory(context: ObserverContext) {
    const response = await requestWithRetry(`${this.baseUrl}/latch-inventory`, this.timeoutMs);
    if (!response.ok)
      throw new Error(`named_latch_evidence_missing:inventory_http:${response.status}`);
    const result = (await response.json()) as any;
    if (result.protocolVersion !== 4)
      throw new Error("named_latch_evidence_missing:collector_protocol");
    return validateOpenEdgeDbLatchInventory(result.latchInventory, context.runId);
  }
  async sample(context: ObserverContext): Promise<MetricSample[]> {
    const response = await requestWithRetry(`${this.baseUrl}${this.metricsPath}`, this.timeoutMs);
    if (!response.ok) throw new Error(`observer_metrics_failed:${response.status}`);
    const parsed = parsePrometheusTextWithDiagnostics(await response.text(), context, this.id);
    const samples = parsed.samples.filter(
      (sample) => sample.labels.phase === context.phase
    ) as MetricSample[] & { diagnostics?: PrometheusParseDiagnostic[] };
    samples.diagnostics = parsed.diagnostics;
    return samples;
  }
}

export interface PrometheusParseDiagnostic {
  line: number;
  code: string;
  message: string;
}

const PARAMETER_SNAPSHOT_LABELS = new Set([
  "database_name",
  "parameter",
  "display_value",
  "value_status",
  "state"
]);

export class PrometheusParseError extends Error {
  constructor(public readonly diagnostics: PrometheusParseDiagnostic[]) {
    super("observer_prometheus_batch_invalid");
    this.name = "PrometheusParseError";
  }
}

export function parsePrometheusText(
  body: string,
  context: ObserverContext,
  service: string
): MetricSample[] {
  const result = parsePrometheusTextWithDiagnostics(body, context, service);
  if (result.diagnostics.length) throw new PrometheusParseError(result.diagnostics);
  return result.samples;
}

export function parsePrometheusTextWithDiagnostics(
  body: string,
  context: ObserverContext,
  service: string
): { samples: MetricSample[]; diagnostics: PrometheusParseDiagnostic[] } {
  const samples: MetricSample[] = [];
  const diagnostics: PrometheusParseDiagnostic[] = [];
  const types = new Map<string, MetricType>();
  for (const line of body.split(/\r?\n/)) {
    const declaration = line.match(/^\s*#\s*TYPE\s+(\w+)\s+(counter|gauge|histogram|info)\s*$/);
    if (declaration) types.set(declaration[1], declaration[2] as MetricType);
  }
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = parseMetricLine(line);
    if (!match) {
      addParseDiagnostic(diagnostics, index + 1, "line_malformed", "invalid Prometheus sample");
      continue;
    }
    let parsedLabels: Record<string, string>;
    try {
      parsedLabels = parseLabels(match[2] ?? "");
      if (
        Object.keys(parsedLabels).length > 64 ||
        Object.entries(parsedLabels).some(([key, value]) => key.length > 128 || value.length > 1024)
      )
        throw new Error("label_bounds_invalid");
    } catch (error) {
      addParseDiagnostic(diagnostics, index + 1, "labels_invalid", String(error));
      continue;
    }
    const value = Number(match[3]);
    if (!Number.isFinite(value)) {
      addParseDiagnostic(diagnostics, index + 1, "value_invalid", "sample value is not finite");
      continue;
    }
    const timestamp = match[4] ? Number(match[4]) / 1000 : Date.now() / 1000;
    if (!Number.isFinite(timestamp)) {
      addParseDiagnostic(
        diagnostics,
        index + 1,
        "timestamp_invalid",
        "sample timestamp is not finite"
      );
      continue;
    }
    const labels = {
      ...observerLabels(context, "observer", service),
      ...parsedLabels
    };
    samples.push({
      metricName: match[1],
      type:
        types.get(match[1]) ??
        (types.get(match[1].replace(/_(bucket|count|sum)$/, "")) === "histogram"
          ? "histogram"
          : match[1].endsWith("_total")
            ? "counter"
            : "gauge"),
      labels,
      timestamp,
      value,
      source: `observer:${service}`
    });
  }
  return { samples, diagnostics };
}

function parseMetricLine(line: string): [string, string, string, string, string?] | null {
  const name = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/);
  if (!name) return null;
  let offset = name[0].length;
  let labelText = "";
  if (line[offset] === "{") {
    const start = ++offset;
    let quoted = false;
    let escaped = false;
    while (offset < line.length) {
      const char = line[offset];
      if (escaped) escaped = false;
      else if (quoted && char === "\\") escaped = true;
      else if (char === '"') quoted = !quoted;
      else if (char === "}" && !quoted) break;
      offset += 1;
    }
    if (offset === line.length) return null;
    labelText = line.slice(start, offset);
    offset += 1;
  }
  const value = line.slice(offset).match(/^\s+([-+0-9.eE]+)(?:\s+([-+]?\d+))?$/);
  return value ? [line, name[1], labelText, value[1], value[2]] : null;
}

async function requestWithRetry(url: string, timeoutMs: number, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts)
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

function parseLabels(value: string): Record<string, string> {
  if (!value.trim()) return {};
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < value.length) {
    const match = value.slice(offset).match(/^([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/);
    if (!match) throw new Error("label_syntax_invalid");
    if (match[1] in result) throw new Error(`label_duplicate:${match[1]}`);
    result[match[1]] = match[2]
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\")
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r");
    offset += match[0].length;
    if (offset === value.length) break;
    if (value[offset] !== ",") throw new Error("label_separator_invalid");
    offset += 1;
    if (offset === value.length) throw new Error("label_separator_invalid");
  }
  return result;
}

function addParseDiagnostic(
  diagnostics: PrometheusParseDiagnostic[],
  line: number,
  code: string,
  message: string
): void {
  if (diagnostics.length < 50) diagnostics.push({ line, code, message });
  else if (diagnostics.length === 50)
    diagnostics.push({ line, code: "diagnostics_truncated", message: "diagnostic limit reached" });
}
