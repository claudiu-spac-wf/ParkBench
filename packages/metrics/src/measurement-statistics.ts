import { Coverage, StatisticValue, SummaryReason } from "../../contracts/src/metric-definitions";
import { MAX_PERCENTILE_BINS, RAW_RESPONSE_SAMPLES } from "./limits";
export interface Observation {
  timestamp: number;
  value: number;
  epoch?: string;
}
export interface MeasurementSeries {
  physicalId?: string;
  activeIntervals?: Array<{ start: number; end: number }>;
  observations: Observation[];
  cadenceSeconds: number;
  /** Maximum age of a source timestamp when acquired by its scraper. */
  acquisitionLagSeconds?: number;
  gapTimes?: number[];
}
interface Piece {
  start: number;
  end: number;
  left: number;
  right: number;
  estimated: boolean;
}
export interface StatisticsOptions {
  type: "counter" | "gauge";
  unit: string;
  totalUnit?: string;
  scale?: number;
  totalScale?: number;
  allowExactEnd?: boolean;
  constituentSelector?: Coverage["constituentSelector"];
}
export interface StatisticsResult {
  statistics: {
    average: StatisticValue;
    p90: StatisticValue;
    p95: StatisticValue;
    total?: StatisticValue;
  };
  coverage: Coverage;
}
const EPS = 0.0011;
const area = (p: Piece, a = p.start, b = p.end) => {
  const slope = (p.right - p.left) / (p.end - p.start),
    left = p.left + slope * (a - p.start),
    right = p.left + slope * (b - p.start);
  return ((left + right) / 2) * (b - a);
};
function build(
  series: MeasurementSeries,
  w: { start: number; end: number },
  o: StatisticsOptions
): { pieces: Piece[]; reasons: SummaryReason[]; count: number } {
  if (series.activeIntervals) {
    const results = series.activeIntervals
      .filter((i) => i.end > i.start)
      .map((i) =>
        build(
          { ...series, activeIntervals: undefined },
          { start: Math.max(w.start, i.start), end: Math.min(w.end, i.end) },
          o
        )
      );
    return {
      pieces: results.flatMap((r) => r.pieces),
      reasons: [...new Set(results.flatMap((r) => r.reasons))],
      count: results.reduce((n, r) => n + r.count, 0)
    };
  }
  const { start: S, end: E } = w,
    c = series.cadenceSeconds;
  if (!Number.isFinite(c) || c <= 0) throw new Error("source_cadence_invalid");
  const lag = series.acquisitionLagSeconds ?? 0;
  if (!Number.isFinite(lag) || lag < 0) throw new Error("source_acquisition_lag_invalid");
  const edgeLimit = c + lag;
  const input = series.observations
    .filter(
      (p) =>
        p.timestamp >= S &&
        (p.timestamp < E || (o.type === "counter" && o.allowExactEnd && p.timestamp === E)) &&
        Number.isFinite(p.value) &&
        Number.isFinite(p.timestamp)
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  const points: Observation[] = [],
    conflicts = new Set(series.gapTimes ?? []),
    reasons = new Set<SummaryReason>();
  for (const point of input) {
    const old = points.at(-1);
    if (old?.timestamp === point.timestamp) {
      if (old.value !== point.value || old.epoch !== point.epoch) {
        conflicts.add(point.timestamp);
        reasons.add("conflicting_observation");
      }
      continue;
    }
    points.push(point);
  }
  const pieces: Piece[] = [];
  let firstInvalid = false,
    lastInvalid = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      dt = b.timestamp - a.timestamp;
    let reason: SummaryReason | undefined;
    if (dt > 1.5 * c + EPS) reason = "insufficient_data";
    else if (a.epoch !== b.epoch || (o.type === "counter" && b.value < a.value))
      reason = "counter_reset_gap";
    else if ([...conflicts].some((t) => t >= a.timestamp && t <= b.timestamp))
      reason = "conflicting_observation";
    if (reason) {
      reasons.add(reason);
      if (!pieces.length) firstInvalid = true;
      lastInvalid = true;
      continue;
    }
    lastInvalid = false;
    const scale = o.scale ?? 1;
    pieces.push({
      start: a.timestamp,
      end: b.timestamp,
      left: o.type === "counter" ? ((b.value - a.value) / dt) * scale : a.value * scale,
      right: o.type === "counter" ? ((b.value - a.value) / dt) * scale : b.value * scale,
      estimated: false
    });
  }
  const first = pieces[0],
    last = pieces.at(-1);
  if (first && !firstInvalid && first.start > S && first.start - S <= edgeLimit + EPS)
    pieces.unshift({
      start: S,
      end: first.start,
      left: first.left,
      right: first.left,
      estimated: true
    });
  if (last && !lastInvalid && E > last.end && E - last.end <= edgeLimit + EPS)
    pieces.push({ start: last.end, end: E, left: last.right, right: last.right, estimated: true });
  return {
    pieces,
    reasons: [...reasons],
    count: points.filter((p) => p.timestamp < E && !conflicts.has(p.timestamp)).length
  };
}
/** Incremental common-interval and additive-total accounting; retains one source at a time. */
export class MeasurementStatisticsAccumulator {
  private common: Piece[] | undefined;
  private members = 0;
  private expectedAcquisitions = 0;
  private observedAcquisitions = 0;
  private observedTotal = 0;
  private estimatedTotal = 0;
  private supported = 0;
  private incomplete = 0;
  private anyEstimated = false;
  private base = 0.001;
  private reasons = new Set<SummaryReason>();
  private activeIntervals: Array<{ start: number; end: number }> = [];
  private unrestricted = false;
  constructor(
    private readonly window: { start: number; end: number },
    private readonly options: StatisticsOptions
  ) {
    if (!Number.isFinite(window.end - window.start) || window.end <= window.start)
      throw new Error("measurement_window_invalid");
  }
  add(series: MeasurementSeries): void {
    if (series.observations.length > RAW_RESPONSE_SAMPLES)
      throw new Error("summary_limit_exceeded:calculation_samples");
    const source = build(series, this.window, this.options),
      T =
        series.activeIntervals?.reduce(
          (n, i) =>
            n +
            Math.max(0, Math.min(this.window.end, i.end) - Math.max(this.window.start, i.start)),
          0
        ) ?? this.window.end - this.window.start;
    if (series.activeIntervals) this.activeIntervals.push(...series.activeIntervals);
    else this.unrestricted = true;
    this.members++;
    this.base = Math.max(this.base, series.cadenceSeconds);
    this.expectedAcquisitions += Math.ceil(T / series.cadenceSeconds);
    this.observedAcquisitions += source.count;
    for (const reason of source.reasons) this.reasons.add(reason);
    if (!source.pieces.length) this.reasons.add("required_member_missing");
    else this.supported++;
    if (source.pieces.reduce((n, p) => n + p.end - p.start, 0) < T - 1e-8) this.incomplete++;
    for (const p of source.pieces) {
      if (p.estimated) {
        this.anyEstimated = true;
        this.estimatedTotal += area(p) * (this.options.totalScale ?? 1);
      } else this.observedTotal += area(p) * (this.options.totalScale ?? 1);
    }
    // A container outside its observed lifetime contributes no resource use and
    // imposes no acquisition requirement on the containers that are active then.
    const commonPieces = [...source.pieces];
    if (series.activeIntervals) {
      let cursor = this.window.start;
      for (const interval of series.activeIntervals) {
        if (interval.start > cursor)
          commonPieces.push({
            start: cursor,
            end: interval.start,
            left: 0,
            right: 0,
            estimated: false
          });
        cursor = Math.max(cursor, interval.end);
      }
      if (cursor < this.window.end)
        commonPieces.push({
          start: cursor,
          end: this.window.end,
          left: 0,
          right: 0,
          estimated: false
        });
      commonPieces.sort((a, b) => a.start - b.start);
    }
    if (this.common === undefined) {
      this.common = commonPieces;
      return;
    }
    const intersection: Piece[] = [];
    let left = 0,
      right = 0;
    while (left < this.common.length && right < commonPieces.length) {
      const a = this.common[left],
        b = commonPieces[right],
        start = Math.max(a.start, b.start),
        end = Math.min(a.end, b.end);
      if (end > start) {
        const sample = (p: Piece, t: number) =>
          p.left + ((p.right - p.left) / (p.end - p.start)) * (t - p.start);
        const p = {
          start,
          end,
          left: sample(a, start) + sample(b, start),
          right: sample(a, end) + sample(b, end),
          estimated: a.estimated || b.estimated
        };
        const prior = intersection.at(-1);
        if (
          prior &&
          prior.end === p.start &&
          prior.estimated === p.estimated &&
          Math.abs(prior.right - p.left) < 1e-10 &&
          Math.abs(
            (prior.right - prior.left) / (prior.end - prior.start) -
              (p.right - p.left) / (p.end - p.start)
          ) < 1e-10
        ) {
          prior.end = p.end;
          prior.right = p.right;
        } else intersection.push(p);
      }
      if (a.end <= b.end) left++;
      if (b.end <= a.end) right++;
    }
    if (intersection.length > RAW_RESPONSE_SAMPLES)
      throw new Error("summary_limit_exceeded:calculation_intervals");
    this.common = intersection;
  }
  finish(): StatisticsResult {
    if (!this.unrestricted) {
      const intervals = this.activeIntervals.sort((a, b) => a.start - b.start),
        union: Array<{ start: number; end: number }> = [];
      for (const interval of intervals) {
        const previous = union.at(-1);
        if (previous && interval.start <= previous.end)
          previous.end = Math.max(previous.end, interval.end);
        else union.push({ ...interval });
      }
      const clipped: Piece[] = [];
      let cursor = 0;
      for (const p of this.common ?? []) {
        while (union[cursor]?.end <= p.start) cursor++;
        for (let index = cursor; index < union.length && union[index].start < p.end; index++) {
          const start = Math.max(p.start, union[index].start),
            end = Math.min(p.end, union[index].end);
          if (end <= start) continue;
          const slope = (p.right - p.left) / (p.end - p.start);
          clipped.push({
            ...p,
            start,
            end,
            left: p.left + slope * (start - p.start),
            right: p.left + slope * (end - p.start)
          });
        }
      }
      this.common = clipped;
    }
    const window = this.window,
      T = window.end - window.start,
      base = this.base,
      step = base * Math.max(1, Math.ceil(T / (MAX_PERCENTILE_BINS * base))),
      common = this.common ?? [],
      reasons = this.reasons;
    if (!this.members) reasons.add("required_member_missing");
    const observed = common.filter((p) => !p.estimated).reduce((n, p) => n + p.end - p.start, 0),
      estimated = common.filter((p) => p.estimated).reduce((n, p) => n + p.end - p.start, 0),
      represented = observed + estimated,
      missing = Math.max(0, T - represented);
    const bins: number[] = [];
    let cursor = 0;
    const fullBins = Math.floor((T + 1e-9) / step);
    for (let i = 0; i < fullBins; i++) {
      const a = window.start + i * step,
        b = a + step;
      while (common[cursor]?.end <= a + 1e-10) cursor++;
      let covered = 0,
        sum = 0;
      for (let j = cursor; j < common.length && common[j].start < b; j++) {
        const p = common[j],
          left = Math.max(a, p.start),
          right = Math.min(b, p.end);
        if (right > left && !p.estimated) {
          covered += right - left;
          sum += area(p, left, right);
        }
      }
      if (Math.abs(covered - step) < 1e-8) bins.push(sum / step);
    }
    const coverage: Coverage = {
      coverageModel: this.members > 1 ? "shared_member_intersection" : "single_source",
      durationSeconds: T,
      observedSeconds: observed,
      estimatedEdgeSeconds: estimated,
      missingSeconds: missing,
      sourceStepSeconds: base,
      observationStepSeconds: step,
      percentileBinCount: bins.length,
      omittedBinCount: Math.max(0, Math.ceil(T / step) - bins.length),
      expectedAcquisitions: this.expectedAcquisitions,
      observedAcquisitions: this.observedAcquisitions,
      reasons: [...reasons]
    };
    const status = missing > 1e-8 ? "partial" : estimated > 1e-8 ? "estimated" : "available";
    const value = (
      v: number | null,
      c = coverage,
      why: SummaryReason[] = [],
      unit = this.options.unit
    ): StatisticValue => ({
      value: v,
      status: v === null ? "unavailable" : status,
      reasons: v === null ? (why.length ? why : ["insufficient_data"]) : c.reasons,
      unit,
      coverage: { ...c }
    });
    const statistics: StatisticsResult["statistics"] = {
      average: value(
        represented > 0 ? common.reduce((n, p) => n + area(p), 0) / represented : null
      ),
      p90: value(null),
      p95: value(null)
    };
    bins.sort((a, b) => a - b);
    for (const [key, q] of [
      ["p90", 0.9],
      ["p95", 0.95]
    ] as const) {
      statistics[key] = value(bins.length >= 2 ? bins[Math.ceil(q * bins.length) - 1] : null);
      if (bins.length >= 2) statistics[key].status = missing > 1e-8 ? "partial" : "available";
    }
    if (this.options.type === "counter" && this.options.totalUnit) {
      const observedTotal = this.observedTotal,
        estimatedTotal = this.estimatedTotal,
        supported = this.supported,
        incomplete = this.incomplete;
      const totalCoverage: Coverage =
        this.members > 1
          ? {
              ...coverage,
              coverageModel: "constituent_additive",
              supportedContributors: supported,
              incompleteContributors: incomplete,
              constituentSelector: this.options.constituentSelector ?? {
                definitionIds: ["resource"],
                group: "database",
                coverageScope: "resource"
              }
            }
          : coverage;
      statistics.total = value(
        supported ? observedTotal + estimatedTotal : null,
        totalCoverage,
        ["insufficient_data"],
        this.options.totalUnit
      );
      statistics.total.observedTotal = observedTotal;
      statistics.total.estimatedTotal = estimatedTotal;
      if (supported)
        statistics.total.status = incomplete
          ? "partial"
          : estimatedTotal !== 0 || this.anyEstimated
            ? "estimated"
            : "available";
    }
    return { statistics, coverage };
  }
}
export function measurementStatistics(
  series: MeasurementSeries[],
  window: { start: number; end: number },
  options: StatisticsOptions
): StatisticsResult {
  const calculation = new MeasurementStatisticsAccumulator(window, options);
  for (const source of series) calculation.add(source);
  return calculation.finish();
}
