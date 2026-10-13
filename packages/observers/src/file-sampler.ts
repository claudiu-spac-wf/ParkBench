import fs from "node:fs";
import path from "node:path";
import { MetricSample } from "../../contracts/src/metrics";
import { ObserverContext, observerLabels } from "./adapter";
export interface FileSample {
  path: string;
  sizeBytes?: number;
  diskUsageBytes?: number;
  exists: boolean;
}
export function samplePath(filePath: string): FileSample {
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false };
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    sizeBytes: stat.isFile() ? stat.size : undefined,
    diskUsageBytes: stat.isDirectory() ? directorySize(filePath) : stat.size,
    exists: true
  };
}
function directorySize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(child) : fs.statSync(child).size;
  }
  return total;
}
export function sampleToMetrics(
  sample: FileSample,
  context: ObserverContext,
  service = "file-sampler"
): MetricSample[] {
  if (!sample.exists) return [];
  const labels = observerLabels(context, "observer", service);
  const timestamp = Date.now() / 1000;
  const metrics: MetricSample[] = [];
  if (sample.sizeBytes !== undefined)
    metrics.push({
      metricName: "parkbench_file_size_bytes",
      labels,
      timestamp,
      value: sample.sizeBytes,
      source: "file-sampler"
    });
  if (sample.diskUsageBytes !== undefined)
    metrics.push({
      metricName: "parkbench_file_disk_usage_bytes",
      labels,
      timestamp,
      value: sample.diskUsageBytes,
      source: "file-sampler"
    });
  return metrics;
}
