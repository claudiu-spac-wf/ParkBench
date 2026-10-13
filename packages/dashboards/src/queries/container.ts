import { containerCpuActivity, containerCpuPercent } from "./container-cpu";
import { freshestContainerReading } from "./container-reading";
import { DISK_EXCLUDE_VAR } from "../filters";
import { Panel, Scope, TopN } from "../model";
import { legend } from "../naming";
import { containerLabel, containerMatchers, HOST_CORES, isRunScoped } from "../scopes";
import { directionalTargets } from "../split";
import { ranking, totals, withOther } from "../topn";

const RATE = "[$__rate_interval]";
const RANGE = "[$__range] @ end()";
const TOP_CONTAINERS = 10;

type ContainerScope = Exclude<Scope, "host">;

function sel(metric: string, matchers: string, extra = ""): string {
  return `${metric}{${[matchers, extra].filter(Boolean).join(",")}}`;
}

/** Queries for the Platform, DB and Run Resources dashboards (FR-014, FR-015, FR-015a). */
export function containerPanels(scope: ContainerScope) {
  const m = containerMatchers(scope);
  const key = containerLabel(scope);
  const runPrefix = isRunScoped(scope);
  const entity = `{{${key}}}`;
  const byRun = "run_id";
  const byKey = `run_id, ${key}`;
  const disk = `device!~"(/dev/)?$${DISK_EXCLUDE_VAR}"`;
  const topN: TopN = {
    n: TOP_CONTAINERS,
    partitionBy: "run_id",
    key,
    otherLabel: "Other",
    tieBreak: "value_then_name",
    excludeZero: true
  };

  const cpuPct = (by: string) => containerCpuPercent(m, by);
  const cpuSecondsScore = (extra: string) =>
    `sum by (${byKey}) (${containerCpuActivity([m, extra].filter(Boolean).join(","), RANGE, "increase")})`;
  const cpuRank = ranking({ key, n: TOP_CONTAINERS, score: cpuSecondsScore });

  const workingSet = (by: string) =>
    `sum by (${by}) (${freshestContainerReading(sel("container_memory_working_set_bytes", m))})`;
  const memScore = (extra: string) =>
    `max by (${byKey}) (max_over_time(${sel("container_memory_working_set_bytes", m, extra)}${RANGE}))`;
  const memRank = ranking({ key, n: TOP_CONTAINERS, score: memScore });

  const fsMetric = (direction: string, unit: "bytes" | "ops") =>
    `container_fs_${direction === "Read" ? "reads" : "writes"}${unit === "bytes" ? "_bytes" : ""}_total`;
  const fsRate = (direction: string, unit: "bytes" | "ops", by: string) => {
    const selector = sel(fsMetric(direction, unit), m, disk);
    return `sum by (${by}) (${freshestContainerReading(selector, `rate(${selector}${RATE})`, "device")})`;
  };
  const diskScore = (extra: string) =>
    `sum by (${byKey}) (increase(${sel("container_fs_reads_bytes_total", m, [disk, extra].filter(Boolean).join(","))}${RANGE})) + on (${byKey}) sum by (${byKey}) (increase(${sel("container_fs_writes_bytes_total", m, [disk, extra].filter(Boolean).join(","))}${RANGE}))`;
  const diskRank = ranking({ key, n: TOP_CONTAINERS, score: diskScore });

  const netMetric = (direction: string, unit: "bytes" | "packets") =>
    `container_network_${direction === "In" ? "receive" : "transmit"}_${unit}_total`;
  const netRate = (direction: string, unit: "bytes" | "packets", by: string) => {
    const selector = sel(netMetric(direction, unit), m);
    return `sum by (${by}) (${freshestContainerReading(selector, `rate(${selector}${RATE})`, "interface")})`;
  };
  const netScore = (unit: "bytes" | "packets") => (extra: string) =>
    `sum by (${byKey}) (increase(${sel(netMetric("In", unit), m, extra)}${RANGE})) + on (${byKey}) sum by (${byKey}) (increase(${sel(netMetric("Out", unit), m, extra)}${RANGE}))`;
  const netBytesRank = ranking({ key, n: TOP_CONTAINERS, score: netScore("bytes") });
  const netPacketsRank = ranking({ key, n: TOP_CONTAINERS, score: netScore("packets") });

  const scopeLabel = scope === "db" ? "DB" : scope === "run" ? "Run containers" : "Platform";

  const summary: Panel[] = [
    {
      id: "summary.cpu",
      title: "CPU usage",
      description:
        "CPU used by the scope's containers, as one-core percentage; 100% means one fully used core.",
      category: "cpu_pct",
      split: "none",
      breakdown: "none",
      visual: "timeseries",
      targets: [{ expr: cpuPct(byRun), legendFormat: legend({ runPrefix, entity: scopeLabel }) }]
    },
    {
      id: "summary.memory",
      title: "Memory usage",
      description:
        "Working set (memory in active use that can't be reclaimed) of the scope's containers.",
      category: "memory",
      split: "none",
      breakdown: "none",
      visual: "timeseries",
      targets: [
        { expr: workingSet(byRun), legendFormat: legend({ runPrefix, entity: scopeLabel }) }
      ]
    },
    {
      id: "summary.disk",
      title: "Disk usage by disk",
      category: "disk_throughput",
      split: "read_write",
      breakdown: "disk",
      visual: "timeseries",
      targets: directionalTargets({
        kind: "disk",
        expr: (d) => fsRate(d, "bytes", "run_id, device"),
        runPrefix,
        entity: "{{device}}"
      })
    },
    {
      id: "summary.network",
      title: "Network usage",
      category: "net_throughput",
      split: "in_out",
      breakdown: "none",
      visual: "timeseries",
      targets: directionalTargets({
        kind: "network",
        expr: (d) => netRate(d, "bytes", byRun),
        runPrefix,
        entity: scopeLabel
      })
    }
  ];

  const cpu: Panel[] = [
    {
      id: "cpu.seconds_by_container",
      title: "CPU seconds by container",
      description:
        "Total CPU time each container used over the selected range (top 10, the rest as Other).",
      category: "cpu_seconds",
      split: "none",
      breakdown: "container",
      topN,
      visual: "bar_totals",
      targets: [
        {
          expr: totals(cpuRank, cpuSecondsScore("")),
          legendFormat: legend({ runPrefix, entity }),
          instant: true
        }
      ]
    }
  ];

  const memory: Panel[] = [
    {
      id: "memory.by_container",
      title: "Memory by container",
      description:
        "Working set per container (top 10, the rest as Other), with page cache and swap for the named containers. A dashed limit line appears only for containers with a memory limit.",
      category: "memory",
      split: "none",
      breakdown: "container",
      topN,
      visual: "timeseries",
      targets: [
        {
          expr: withOther(memRank, workingSet(byKey)),
          legendFormat: legend({ runPrefix, entity: `${entity} · Working set` })
        },
        {
          expr: memRank.named(
            `sum by (${byKey}) (${freshestContainerReading(sel("container_memory_cache", m))})`
          ),
          legendFormat: legend({ runPrefix, entity: `${entity} · Cache` })
        },
        {
          expr: memRank.named(
            `sum by (${byKey}) (${freshestContainerReading(sel("container_memory_swap", m))})`
          ),
          legendFormat: legend({ runPrefix, entity: `${entity} · Swap` })
        },
        {
          expr: memRank.named(
            `max by (${byKey}) (${freshestContainerReading(sel("container_spec_memory_limit_bytes", m), `${sel("container_spec_memory_limit_bytes", m)} > 0`)})`
          ),
          legendFormat: legend({ runPrefix, entity: `${entity} · Limit` })
        }
      ],
      overrides: [
        {
          matcher: { id: "byRegexp", options: ".*· Limit$" },
          properties: [
            { id: "custom.lineStyle", value: { fill: "dash", dash: [10, 10] } },
            { id: "custom.fillOpacity", value: 0 }
          ]
        }
      ]
    }
  ];

  const diskPanels: Panel[] = [
    {
      id: "disk.throughput_by_disk",
      title: "Disk throughput by disk",
      category: "disk_throughput",
      split: "read_write",
      breakdown: "disk",
      visual: "timeseries",
      targets: directionalTargets({
        kind: "disk",
        expr: (d) => fsRate(d, "bytes", "run_id, device"),
        runPrefix,
        entity: "{{device}}"
      })
    },
    {
      id: "disk.iops_by_disk",
      title: "Disk IOPS by disk",
      category: "disk_iops",
      split: "read_write",
      breakdown: "disk",
      visual: "timeseries",
      targets: directionalTargets({
        kind: "disk",
        expr: (d) => fsRate(d, "ops", "run_id, device"),
        runPrefix,
        entity: "{{device}}"
      })
    },
    {
      id: "disk.throughput_by_container",
      title: "Disk throughput by container",
      description:
        "Read and write throughput per container (top 10 by total bytes, the rest as Other).",
      category: "disk_throughput",
      split: "read_write",
      breakdown: "container",
      topN,
      visual: "timeseries",
      targets: directionalTargets({
        kind: "disk",
        expr: (d) => withOther(diskRank, fsRate(d, "bytes", byKey)),
        runPrefix,
        entity
      })
    }
  ];

  const network: Panel[] = [
    {
      id: "network.throughput",
      title: "Network throughput by container",
      description: "In and out traffic per container (top 10 by total bytes, the rest as Other).",
      category: "net_throughput",
      split: "in_out",
      breakdown: "container",
      topN,
      visual: "timeseries",
      targets: directionalTargets({
        kind: "network",
        expr: (d) => withOther(netBytesRank, netRate(d, "bytes", byKey)),
        runPrefix,
        entity
      })
    },
    {
      id: "network.packets",
      title: "Network packets by container",
      category: "net_packets",
      split: "in_out",
      breakdown: "container",
      topN,
      visual: "timeseries",
      targets: directionalTargets({
        kind: "network",
        expr: (d) => withOther(netPacketsRank, netRate(d, "packets", byKey)),
        runPrefix,
        entity
      })
    }
  ];

  return { summary, cpu, memory, disk: diskPanels, network };
}
