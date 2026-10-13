import { MetricSample } from "../../contracts/src/metrics";
import { physicalIdentity, parentCgroups } from "./resource-membership";
export interface AccountingGap {
  reason: "conflicting_observation";
  metricName: string;
  physicalId: string;
  timestamp: number;
}
export function accountResourceSamples(
  input: MetricSample[],
  options: { cadenceSeconds?: number } = {}
): { samples: MetricSample[]; gaps: AccountingGap[] } {
  const groups = new Map<string, MetricSample[]>(),
    gaps: AccountingGap[] = [];
  const parents = parentCgroups(input);
  input = input.filter(
    (sample) =>
      !sample.metricName.startsWith("container_") ||
      (!!physicalIdentity(sample) && !parents.has(physicalIdentity(sample)!))
  );
  for (const s of input) {
    if (!Number.isFinite(s.value) || !Number.isFinite(s.timestamp)) continue;
    const id =
      physicalIdentity(s) ?? s.labels.name ?? s.labels.replica ?? s.labels.database ?? "native";
    const dimensions = Object.entries(s.labels)
      .filter(
        ([k]) =>
          ![
            "job",
            "instance",
            "source",
            "phase",
            "experiment_id",
            "variant_id",
            "repetition",
            "component",
            "run_id",
            "container_label_parkbench_run_id",
            "container_label_com_docker_compose_project",
            "container_label_com_docker_compose_service",
            "service",
            "replica",
            "id",
            "container_id",
            "name",
            "image",
            "accounting_epoch"
          ].includes(k) && !k.startsWith("container_label_")
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const key = JSON.stringify([
      s.metricName,
      id,
      s.labels.database_epoch ?? s.labels.epoch ?? "",
      dimensions
    ]);
    const a = groups.get(key) ?? [];
    a.push(s);
    groups.set(key, a);
  }
  const result: MetricSample[] = [];
  for (const samples of groups.values()) {
    const preferred = samples.some((s) => s.labels.job === "parkbench-run-owned-cadvisor")
      ? "parkbench-run-owned-cadvisor"
      : samples.some((s) => s.labels.job === "cadvisor")
        ? "cadvisor"
        : samples[0].labels.job;
    const streams = new Map<string, MetricSample[]>();
    for (const sample of samples) {
      const source = sample.labels.job ?? sample.source;
      const list = streams.get(source) ?? [];
      list.push(sample);
      streams.set(source, list);
    }
    const primary = preferred ?? samples[0].source;
    const segments = (stream: MetricSample[], source: string) => {
      const at = new Map<number, MetricSample[]>();
      for (const sample of stream) {
        const values = at.get(sample.timestamp) ?? [];
        values.push(sample);
        at.set(sample.timestamp, values);
      }
      const unique: MetricSample[] = [];
      for (const values of at.values()) {
        const first = values[0];
        if (values.some((s) => s.value !== first.value)) {
          if (source === primary)
            gaps.push({
              reason: "conflicting_observation",
              metricName: first.metricName,
              physicalId: physicalIdentity(first) ?? "native",
              timestamp: first.timestamp
            });
          continue;
        }
        unique.push(first);
      }
      unique.sort((a, b) => a.timestamp - b.timestamp);
      const parts: MetricSample[][] = [];
      const c = options.cadenceSeconds;
      for (const sample of unique) {
        let part = parts.at(-1);
        const last = part?.at(-1);
        if (
          !part ||
          (c !== undefined &&
            last &&
            (sample.timestamp - last.timestamp > 1.5 * c + 0.0011 ||
              (sample.type === "counter" && sample.value < last.value)))
        ) {
          part = [];
          parts.push(part);
        }
        part.push(sample);
      }
      return parts.map((part, index) =>
        part.map((sample) => ({
          ...sample,
          labels: {
            ...sample.labels,
            accounting_epoch: JSON.stringify([
              sample.labels.epoch ??
                sample.labels.database_epoch ??
                physicalIdentity(sample) ??
                "native",
              source,
              index
            ])
          }
        }))
      );
    };
    const selected = segments(streams.get(primary) ?? [], primary),
      intervals = selected.map((part) => ({
        start: part[0].timestamp,
        end: part.at(-1)!.timestamp
      }));
    result.push(...selected.flat());
    if (options.cadenceSeconds !== undefined)
      for (const [source, stream] of streams) {
        if (source === primary) continue;
        for (const segment of segments(stream, source)) {
          const start = segment[0].timestamp,
            end = segment.at(-1)!.timestamp;
          if (segment.length < 2 || intervals.some((i) => start <= i.end && end >= i.start))
            continue;
          result.push(...segment);
          intervals.push({ start, end });
        }
      }
  }
  const representation = new Map<string, Set<string>>();
  for (const s of result) {
    const id = physicalIdentity(s) ?? "native",
      epoch = s.labels.epoch ?? s.labels.database_epoch ?? "",
      key = JSON.stringify([s.metricName, id, epoch]),
      dimension =
        s.metricName === "container_cpu_usage_seconds_total"
          ? (s.labels.cpu ?? "total")
          : s.metricName.startsWith("container_fs_")
            ? (s.labels.device ?? "total")
            : s.metricName.startsWith("container_network_")
              ? (s.labels.interface ?? "total")
              : "";
    const set = representation.get(key) ?? new Set();
    set.add(dimension);
    representation.set(key, set);
  }
  const samples = result.filter((s) => {
    const key = JSON.stringify([
        s.metricName,
        physicalIdentity(s) ?? "native",
        s.labels.epoch ?? s.labels.database_epoch ?? ""
      ]),
      set = representation.get(key);
    if (s.metricName === "container_cpu_usage_seconds_total" && set.has("total"))
      return !s.labels.cpu || s.labels.cpu === "total";
    if (s.metricName.startsWith("container_fs_") && set.has("total"))
      return !s.labels.device || s.labels.device === "total";
    if (s.metricName.startsWith("container_network_")) {
      if (s.labels.interface === "lo") return false;
      if (set.has("total")) return !s.labels.interface || s.labels.interface === "total";
    }
    return true;
  });
  return { samples: samples.sort((a, b) => a.timestamp - b.timestamp), gaps };
}
