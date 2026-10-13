import { PanelCategory } from "./model";

export interface UnitConvention {
  unit: string;
  axisLabel?: string;
  min?: number;
  max?: number;
  decimals?: number;
}

/**
 * The single unit table every panel takes its unit from (FR-001 to FR-007).
 * Byte units are Grafana's IEC units (KiB, MiB, GiB and KiB/s, MiB/s).
 */
export const UNIT_CONVENTIONS: Record<PanelCategory, UnitConvention> = {
  cpu_pct: { unit: "percent", min: 0 },
  cpu_host_pct: { unit: "percent", min: 0, max: 100 },
  cpu_seconds: { unit: "s", min: 0 },
  memory: { unit: "bytes", min: 0 },
  disk_throughput: { unit: "Bps", min: 0 },
  disk_iops: { unit: "iops", min: 0 },
  net_throughput: { unit: "Bps", min: 0 },
  net_packets: { unit: "pps", min: 0 },
  table_rate: { unit: "short", axisLabel: "records/s", min: 0 },
  table_total: { unit: "short", axisLabel: "records", min: 0 },
  requests: { unit: "reqps", min: 0 },
  duration: { unit: "s", min: 0 },
  count: { unit: "short", min: 0 },
  ratio: { unit: "percentunit", min: 0, max: 1 },
  event_rate: { unit: "ops", min: 0 },
  duration_rate: { unit: "suffix:s/s", min: 0 },
  state: { unit: "none" }
};

export function unitFor(category: PanelCategory): UnitConvention {
  return UNIT_CONVENTIONS[category];
}

export const DISK_CATEGORIES: readonly PanelCategory[] = ["disk_throughput", "disk_iops"];
export const NETWORK_CATEGORIES: readonly PanelCategory[] = ["net_throughput", "net_packets"];
