import { PrometheusClient } from "./prometheus-client";

export const DISK_IO_SOURCES = {
  container: "cadvisor",
  host: "node-exporter:block-device",
  files: "file-sampler"
} as const;

export const DISK_IO_QUERIES = {
  container: "container_fs_reads_bytes_total",
  containerRead: "container_fs_reads_bytes_total",
  containerWrite: "container_fs_writes_bytes_total",
  containerReadOperations: "container_fs_reads_total",
  containerWriteOperations: "container_fs_writes_total",
  containerIoTime: "container_fs_io_time_seconds_total",
  host: "node_disk_read_bytes_total",
  hostRead: "node_disk_read_bytes_total",
  hostWrite: "node_disk_written_bytes_total",
  hostReadOperations: "node_disk_reads_completed_total",
  hostWriteOperations: "node_disk_writes_completed_total",
  hostIoTime: "node_disk_io_time_seconds_total"
} as const;
export function normalizeDiskIoSource(component: "container" | "host"): string {
  return DISK_IO_SOURCES[component];
}
export function requireDiskIoSources(available: {
  cadvisor: boolean;
  nodeExporterBlockDevice: boolean;
}): void {
  if (!available.cadvisor || !available.nodeExporterBlockDevice)
    throw new Error("required_disk_io_source_unavailable");
}

export async function verifyDiskIoSources(
  client: PrometheusClient,
  cadvisorUrl?: string
): Promise<{
  cadvisor: boolean;
  nodeExporterBlockDevice: boolean;
}> {
  const [
    containerRead,
    containerWrite,
    containerReadOperations,
    containerWriteOperations,
    containerIoTime,
    hostRead,
    hostWrite,
    hostReadOperations,
    hostWriteOperations,
    hostIoTime
  ] = await Promise.all([
    cadvisorUrl
      ? probeCAdvisorMetrics(cadvisorUrl)
      : client.queryInstant(DISK_IO_QUERIES.containerRead),
    cadvisorUrl ? Promise.resolve([]) : client.queryInstant(DISK_IO_QUERIES.containerWrite),
    cadvisorUrl
      ? Promise.resolve([])
      : client.queryInstant(DISK_IO_QUERIES.containerReadOperations),
    cadvisorUrl
      ? Promise.resolve([])
      : client.queryInstant(DISK_IO_QUERIES.containerWriteOperations),
    cadvisorUrl ? Promise.resolve([]) : client.queryInstant(DISK_IO_QUERIES.containerIoTime),
    client.queryInstant(DISK_IO_QUERIES.hostRead),
    client.queryInstant(DISK_IO_QUERIES.hostWrite),
    client.queryInstant(DISK_IO_QUERIES.hostReadOperations),
    client.queryInstant(DISK_IO_QUERIES.hostWriteOperations),
    client.queryInstant(DISK_IO_QUERIES.hostIoTime)
  ]);
  const available = {
    cadvisor: cadvisorUrl
      ? containerRead.length > 0
      : containerRead.length > 0 &&
        containerWrite.length > 0 &&
        containerReadOperations.length > 0 &&
        containerWriteOperations.length > 0 &&
        containerIoTime.length > 0,
    nodeExporterBlockDevice:
      hostRead.length > 0 &&
      hostWrite.length > 0 &&
      hostReadOperations.length > 0 &&
      hostWriteOperations.length > 0 &&
      hostIoTime.length > 0
  };
  requireDiskIoSources(available);
  return available;
}

async function probeCAdvisorMetrics(baseUrl: string): Promise<PrometheusClientResult> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/metrics`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return { length: 0 };
    const body = await response.text();
    const required = [
      "container_fs_reads_bytes_total",
      "container_fs_writes_bytes_total",
      "container_fs_reads_total",
      "container_fs_writes_total",
      "container_fs_io_time_seconds_total"
    ];
    const has = (name: string) =>
      body.split(/\r?\n/).some((line) => new RegExp(`^${name}(?:\\{|\\s)`).test(line));
    return { length: required.every(has) ? 1 : 0 };
  } catch {
    return { length: 0 };
  }
}

interface PrometheusClientResult {
  length: number;
}
