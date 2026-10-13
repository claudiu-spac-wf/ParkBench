import { normalizeHistoricalPasAliases } from "./historical-summary-input";
import { Run } from "../../contracts/src/run";
import {
  SummaryRow,
  MetricDefinition,
  ResourceMembership,
  SummaryReason
} from "../../contracts/src/metric-definitions";
import {
  semanticRowKey,
  validateSummaryRow,
  MeasurementWindow
} from "../../contracts/src/run-summary";
import { PrometheusClient } from "./prometheus-client";
import { readRawChunks, RawQueryOptions } from "./raw-query";
import { RESOURCE_SUMMARY_CATALOG, FILE_SUMMARY_CATALOG } from "./summary-catalog";
import {
  measurementStatistics,
  MeasurementSeries,
  StatisticsResult
} from "./measurement-statistics";
import { accountResourceSamples } from "./resource-accounting";
import {
  physicalIdentity,
  ExpectedResourceMember,
  missingResourceMembers
} from "./resource-membership";
import { RAW_RESPONSE_SAMPLES } from "./limits";
import type { MetricSample } from "../../contracts/src/metrics";
export const quotePromLabel = (s: string) => JSON.stringify(s);
export interface MeasurementBuildOptions {
  run: Run;
  window: MeasurementWindow;
  memberships: ResourceMembership[];
  expectedMembers?: ExpectedResourceMember[];
  sourceStepSeconds: number;
  cadvisorHousekeepingSeconds?: number;
  nativeStepSeconds?: number;
  priority?: RawQueryOptions["priority"];
  signal?: AbortSignal;
  historical?: boolean;
  queries: Array<{
    selector: string;
    start: number;
    end: number;
    outcome?: string;
    reason?: string;
  }>;
}
export function unavailableSummaryRow(
  definition: MetricDefinition,
  dimensions: Record<string, string>,
  duration: number,
  cadence: number,
  reason: SummaryReason
): SummaryRow {
  const coverage = {
    coverageModel: "single_source" as const,
    durationSeconds: duration,
    observedSeconds: 0,
    estimatedEdgeSeconds: 0,
    missingSeconds: duration,
    sourceStepSeconds: cadence,
    observationStepSeconds: cadence,
    percentileBinCount: 0,
    omittedBinCount: Math.ceil(duration / cadence),
    expectedAcquisitions: Math.ceil(duration / cadence),
    observedAcquisitions: 0,
    reasons: [reason]
  };
  const row: SummaryRow = {
    rowKey: "",
    definitionId: definition.definitionId,
    group: definition.group,
    displayName: definition.displayName,
    coverageScope: definition.coverageScope,
    dimensions,
    rateOrLevelUnit: definition.rateOrLevelUnit,
    totalUnit: definition.totalUnit,
    statistics: Object.fromEntries(
      definition.supportedStatistics.map((s) => [
        s,
        {
          value: null,
          status: "unavailable",
          unit: s === "total" ? definition.totalUnit : definition.rateOrLevelUnit,
          reasons: [reason],
          coverage
        }
      ])
    ),
    coverage,
    sourceReferences: definition.sourceMetricNames.map((metric) => ({
      metric,
      contractVersion: definition.sourceContractVersion
    })),
    catalogOrder: definition.catalogOrder ?? 0
  };
  row.rowKey = semanticRowKey(row);
  validateSummaryRow(row);
  return row;
}
export function calculateSummaryRow(
  definition: MetricDefinition,
  dimensions: Record<string, string>,
  series: MeasurementSeries[],
  window: { start: number; end: number }
): SummaryRow {
  const result = measurementStatistics(series, window, {
    type: definition.type,
    unit: definition.rateOrLevelUnit,
    totalUnit: definition.totalUnit ?? undefined,
    scale: definition.scale ?? 1,
    totalScale: definition.totalScale ?? 1,
    allowExactEnd: definition.type === "counter",
    constituentSelector: {
      definitionIds: [definition.definitionId],
      group: definition.group,
      coverageScope: definition.coverageScope,
      dimensions
    }
  });
  return summaryRowFromStatistics(definition, dimensions, result);
}
export function summaryRowFromStatistics(
  definition: MetricDefinition,
  dimensions: Record<string, string>,
  result: StatisticsResult
): SummaryRow {
  const row: SummaryRow = {
    rowKey: "",
    definitionId: definition.definitionId,
    group: definition.group,
    displayName: definition.displayName,
    coverageScope: definition.coverageScope,
    dimensions,
    rateOrLevelUnit: definition.rateOrLevelUnit,
    totalUnit: definition.totalUnit,
    statistics: result.statistics,
    coverage: result.coverage,
    sourceReferences: definition.sourceMetricNames.map((metric) => ({
      metric,
      contractVersion: definition.sourceContractVersion
    })),
    catalogOrder: definition.catalogOrder ?? 0
  };
  row.rowKey = semanticRowKey(row);
  validateSummaryRow(row);
  return row;
}
export async function acquireMetric(
  client: PrometheusClient,
  selector: string,
  options: MeasurementBuildOptions,
  cadence: number,
  includeExactEnd: boolean
): Promise<MetricSample[]> {
  if (options.window.start === null || options.window.end === null) return [];
  const start = Date.parse(options.window.start) / 1000,
    end = Date.parse(options.window.end) / 1000,
    result: MetricSample[] = [];
  try {
    for await (const chunk of readRawChunks(client, selector, start, end, cadence, {
      priority: options.priority,
      signal: options.signal,
      includeExactEnd
    })) {
      result.push(
        ...(options.historical ? normalizeHistoricalPasAliases(chunk.samples) : chunk.samples)
      );
      if (result.length > RAW_RESPONSE_SAMPLES)
        throw new Error("summary_limit_exceeded:calculation_samples");
      options.queries.push({
        selector: chunk.query,
        start: chunk.start,
        end: chunk.end,
        outcome: "success"
      });
    }
  } catch (error) {
    options.queries.push({
      selector,
      start,
      end,
      outcome: "unavailable",
      reason: String(error).includes("summary_limit_exceeded")
        ? "summary_limit_exceeded"
        : String(error).includes("query_timeout")
          ? "query_timeout"
          : "source_unavailable"
    });
    throw error;
  }
  return result;
}
export function metricSeries(samples: MetricSample[], cadence: number): MeasurementSeries[] {
  const series = new Map<string, MeasurementSeries>();
  for (const s of samples) {
    const key = JSON.stringify([
      physicalIdentity(s) ?? s.labels.replica ?? s.labels.table ?? s.labels.database ?? "native",
      s.labels.cpu ?? "",
      s.labels.device ?? "",
      s.labels.interface ?? "",
      s.labels.pool ?? "",
      s.labels.operation ?? ""
    ]);
    let entry = series.get(key);
    if (!entry) {
      entry = { cadenceSeconds: cadence, observations: [], physicalId: physicalIdentity(s) };
      series.set(key, entry);
    }
    entry.observations.push({
      timestamp: s.timestamp,
      value: s.value,
      epoch:
        s.labels.accounting_epoch ??
        s.labels.database_epoch ??
        s.labels.epoch ??
        physicalIdentity(s)
    });
  }
  return [...series.values()];
}
export async function* buildResourceSummaryRows(
  client: PrometheusClient,
  options: MeasurementBuildOptions
): AsyncGenerator<SummaryRow> {
  const duration = options.window.durationSeconds,
    cadence = options.sourceStepSeconds,
    start = Date.parse(options.window.start ?? "") / 1000,
    end = Date.parse(options.window.end ?? "") / 1000;
  for (const definition of RESOURCE_SUMMARY_CATALOG) {
    const members = options.memberships.filter((m) => m.group === definition.group),
      expected = (options.expectedMembers ?? []).filter((m) => m.group === definition.group),
      replicas =
        definition.group === "pas"
          ? [...new Set([...members, ...expected].map((m) => m.replica).filter(Boolean))]
          : [];
    const dimensions: Record<string, string> = {};
    if (definition.definitionId.startsWith("disk."))
      dimensions.direction = definition.definitionId.includes("read") ? "read" : "write";
    if (definition.definitionId.startsWith("network."))
      dimensions.direction = definition.definitionId.endsWith("receive") ? "receive" : "transmit";
    if (
      options.window.state === "not_started" ||
      !options.window.start ||
      !options.window.end ||
      options.window.durationSeconds <= 0
    ) {
      yield unavailableSummaryRow(
        definition,
        dimensions,
        0,
        cadence,
        options.window.state === "not_started"
          ? "measurement_not_started"
          : !options.window.start || !options.window.end
            ? "measurement_boundaries_missing"
            : "insufficient_data"
      );
      continue;
    }
    const scope =
      definition.group === "platform"
        ? `job="cadvisor",container_label_com_docker_compose_project="parkbench-platform",container_label_com_docker_compose_service!=""`
        : `job="parkbench-run-owned-cadvisor",run_id=${quotePromLabel(options.run.id)},service${definition.group === "database" ? '="database"' : '=~"pas-[0-9]+"'}`;
    let input: MetricSample[];
    try {
      input = await acquireMetric(
        client,
        `${definition.sourceMetricNames[0]}{${scope}}`,
        options,
        cadence,
        definition.type === "counter"
      );
      if (options.historical && definition.group !== "platform") {
        const service = definition.group === "database" ? '="database"' : '=~"pas-[0-9]+"';
        const secondary = await acquireMetric(
          client,
          `${definition.sourceMetricNames[0]}{job="cadvisor",container_label_parkbench_run_id=${quotePromLabel(options.run.id)},container_label_com_docker_compose_service${service}}`,
          options,
          cadence,
          definition.type === "counter"
        );
        input.push(...secondary);
        if (input.length > RAW_RESPONSE_SAMPLES)
          throw new Error("summary_limit_exceeded:calculation_samples");
      }
    } catch (error) {
      const reason: SummaryReason = String(error).includes("summary_limit_exceeded")
        ? "summary_limit_exceeded"
        : String(error).includes("query_timeout")
          ? "query_timeout"
          : "source_unavailable";
      yield unavailableSummaryRow(definition, dimensions, duration, cadence, reason);
      for (const replica of replicas)
        yield unavailableSummaryRow(
          definition,
          { ...dimensions, replica, service: replica },
          duration,
          cadence,
          reason
        );
      continue;
    }
    // Use only inventoried physical members where the run has an ownership inventory.
    const owned =
      members.length || expected.length
        ? input.filter((s) =>
            members.some(
              (m) =>
                physicalIdentity(s) === m.physicalId ||
                physicalIdentity(s)?.endsWith("/" + m.physicalId)
            )
          )
        : input;
    const accounted = accountResourceSamples(owned, { cadenceSeconds: cadence });
    const make = (
      samples: MetricSample[],
      requiredMembers: ResourceMembership[],
      expectedMembers = expected
    ) => {
      const series = metricSeries(samples, cadence);
      for (const missing of missingResourceMembers(expectedMembers, requiredMembers))
        series.push({
          cadenceSeconds: cadence,
          observations: [],
          activeIntervals: [{ start, end }]
        });
      for (const m of requiredMembers)
        if (
          !samples.some(
            (s) =>
              physicalIdentity(s) === m.physicalId ||
              physicalIdentity(s)?.endsWith("/" + m.physicalId)
          )
        )
          series.push({
            cadenceSeconds: cadence,
            observations: [],
            physicalId: m.physicalId,
            activeIntervals: m.activeIntervals
          });
      // Replacements of a physical ID are distinct accounting epochs even if counters rise.
      for (const source of series) {
        source.acquisitionLagSeconds = options.cadvisorHousekeepingSeconds ?? 0;
        const observedMember = requiredMembers.filter((m) => m.physicalId === source.physicalId);
        if (observedMember.length)
          source.activeIntervals = observedMember
            .flatMap((m) => m.activeIntervals)
            .sort((a, b) => a.start - b.start)
            .reduce<Array<{ start: number; end: number }>>((intervals, i) => {
              const last = intervals.at(-1);
              if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
              else intervals.push({ ...i });
              return intervals;
            }, []);
        for (const observation of source.observations) {
          const member = [...observedMember]
            .reverse()
            .find((m) =>
              m.activeIntervals.some(
                (i) => observation.timestamp >= i.start && observation.timestamp <= i.end
              )
            );
          if (member) observation.epoch = JSON.stringify([member.epoch, observation.epoch]);
        }
      }
      for (const s of series)
        s.gapTimes = accounted.gaps
          .filter((g) => g.physicalId === s.physicalId)
          .map((g) => g.timestamp);
      return series;
    };
    yield calculateSummaryRow(definition, dimensions, make(accounted.samples, members), {
      start,
      end
    });
    for (const replica of replicas) {
      const samples = accounted.samples.filter(
        (s) => (s.labels.service ?? s.labels.container_label_com_docker_compose_service) === replica
      );
      yield calculateSummaryRow(
        definition,
        { ...dimensions, replica, service: replica },
        make(
          samples,
          members.filter((m) => m.replica === replica),
          expected.filter((m) => m.replica === replica)
        ),
        { start, end }
      );
    }
  }
  for (const definition of FILE_SUMMARY_CATALOG) {
    if (
      options.window.state === "not_started" ||
      !options.window.start ||
      !options.window.end ||
      options.window.durationSeconds <= 0
    ) {
      yield unavailableSummaryRow(
        definition,
        { scope: definition.coverageScope },
        0,
        cadence,
        options.window.state === "not_started"
          ? "measurement_not_started"
          : !options.window.start || !options.window.end
            ? "measurement_boundaries_missing"
            : "insufficient_data"
      );
      continue;
    }
    let samples: MetricSample[];
    try {
      samples = await acquireMetric(
        client,
        `${definition.sourceMetricNames[0]}{run_id=${quotePromLabel(options.run.id)}}`,
        options,
        cadence,
        false
      );
    } catch {
      yield unavailableSummaryRow(
        definition,
        { scope: definition.coverageScope },
        duration,
        cadence,
        "source_unavailable"
      );
      continue;
    }
    const groups = new Map<string, MetricSample[]>();
    for (const sample of samples) {
      const file =
        sample.labels.file ??
        sample.labels.path ??
        sample.labels.service ??
        definition.coverageScope;
      const list = groups.get(file) ?? [];
      list.push(sample);
      groups.set(file, list);
    }
    if (!groups.size)
      yield unavailableSummaryRow(
        definition,
        { scope: definition.coverageScope },
        duration,
        cadence,
        "not_collected"
      );
    for (const [file, values] of groups)
      yield calculateSummaryRow(
        definition,
        { scope: definition.coverageScope, file },
        metricSeries(values, cadence),
        { start, end }
      );
  }
}
