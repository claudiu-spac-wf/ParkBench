import { DISK_EXCLUDE_VAR, INTERFACE_EXCLUDE_VAR } from "../filters";
import { Panel } from "../model";
import { hostMatchers } from "../scopes";
import { directionalTargets } from "../split";

const JOB = hostMatchers();
const RATE = "[$__rate_interval]";
const DISK = `${JOB},device!~"$${DISK_EXCLUDE_VAR}"`;
const IFACE = `${JOB},device!~"$${INTERFACE_EXCLUDE_VAR}"`;

const mem = (name: string) => `node_memory_${name}_bytes{${JOB}}`;

function diskBytes(direction: string): string {
  const metric =
    direction === "Read" ? "node_disk_read_bytes_total" : "node_disk_written_bytes_total";
  return `sum by (device) (rate(${metric}{${DISK}}${RATE}))`;
}

function diskOps(direction: string): string {
  const metric =
    direction === "Read" ? "node_disk_reads_completed_total" : "node_disk_writes_completed_total";
  return `sum by (device) (rate(${metric}{${DISK}}${RATE}))`;
}

function netRate(unit: "bytes" | "packets", direction: string): string {
  const way = direction === "In" ? "receive" : "transmit";
  return `sum by (device) (rate(node_network_${way}_${unit}_total{${IFACE}}${RATE}))`;
}

const dashedLine = (regex: string) => ({
  matcher: { id: "byRegexp", options: regex },
  properties: [
    { id: "custom.lineStyle", value: { fill: "dash", dash: [10, 10] } },
    { id: "custom.fillOpacity", value: 0 }
  ]
});

export function hostPanels() {
  const cpuOverall: Panel = {
    id: "summary.cpu",
    title: "CPU usage",
    description: "Overall host CPU usage, 0–100% of all cores.",
    category: "cpu_host_pct",
    split: "none",
    breakdown: "none",
    visual: "timeseries",
    targets: [
      {
        expr: `100 * (1 - avg(rate(node_cpu_seconds_total{${JOB},mode="idle"}${RATE})))`,
        legendFormat: "CPU"
      }
    ]
  };
  const memoryUsed: Panel = {
    id: "summary.memory",
    title: "Memory usage",
    description: "Memory in use (total minus available), with total memory as a reference line.",
    category: "memory",
    split: "none",
    breakdown: "none",
    visual: "timeseries",
    targets: [
      { expr: `${mem("MemTotal")} - ${mem("MemAvailable")}`, legendFormat: "Used" },
      { expr: mem("MemTotal"), legendFormat: "Total" }
    ],
    overrides: [dashedLine("^Total$")]
  };
  const diskThroughput = (id: string, title: string): Panel => ({
    id,
    title,
    description: "Read and write throughput per physical disk.",
    category: "disk_throughput",
    split: "read_write",
    breakdown: "disk",
    visual: "timeseries",
    targets: directionalTargets({
      kind: "disk",
      expr: diskBytes,
      runPrefix: false,
      entity: "{{device}}"
    })
  });
  const netThroughput = (id: string, title: string): Panel => ({
    id,
    title,
    description:
      "Traffic per physical network interface. Loopback, Docker bridges and container interfaces are excluded.",
    category: "net_throughput",
    split: "in_out",
    breakdown: "interface",
    visual: "timeseries",
    targets: directionalTargets({
      kind: "network",
      expr: (direction) => netRate("bytes", direction),
      runPrefix: false,
      entity: "{{device}}"
    })
  });
  return {
    summary: [
      cpuOverall,
      memoryUsed,
      diskThroughput("summary.disk", "Disk usage by disk"),
      netThroughput("summary.network", "Network usage")
    ],
    cpu: [
      {
        id: "cpu.per_core",
        title: "CPU usage by core",
        category: "cpu_host_pct",
        split: "none",
        breakdown: "core",
        visual: "timeseries",
        targets: [
          {
            expr: `100 * (1 - avg by (cpu) (rate(node_cpu_seconds_total{${JOB},mode="idle"}${RATE})))`,
            legendFormat: "cpu {{cpu}}"
          }
        ]
      } satisfies Panel
    ],
    memory: [
      {
        id: "memory.composition",
        title: "Memory composition",
        description: "Used, cached/buffers and available memory, plus swap in use.",
        category: "memory",
        split: "none",
        breakdown: "none",
        visual: "timeseries",
        targets: [
          { expr: `${mem("MemTotal")} - ${mem("MemAvailable")}`, legendFormat: "Used" },
          { expr: `${mem("Cached")} + ${mem("Buffers")}`, legendFormat: "Cached/buffers" },
          { expr: mem("MemAvailable"), legendFormat: "Available" },
          { expr: `${mem("SwapTotal")} - ${mem("SwapFree")}`, legendFormat: "Swap used" }
        ]
      } satisfies Panel
    ],
    disk: [
      diskThroughput("disk.throughput_by_disk", "Disk throughput by disk"),
      {
        id: "disk.iops_by_disk",
        title: "Disk IOPS by disk",
        category: "disk_iops",
        split: "read_write",
        breakdown: "disk",
        visual: "timeseries",
        targets: directionalTargets({
          kind: "disk",
          expr: diskOps,
          runPrefix: false,
          entity: "{{device}}"
        })
      } satisfies Panel
    ],
    network: [
      netThroughput("network.throughput", "Network throughput"),
      {
        id: "network.packets",
        title: "Network packets",
        category: "net_packets",
        split: "in_out",
        breakdown: "interface",
        visual: "timeseries",
        targets: directionalTargets({
          kind: "network",
          expr: (direction) => netRate("packets", direction),
          runPrefix: false,
          entity: "{{device}}"
        })
      } satisfies Panel
    ]
  };
}
