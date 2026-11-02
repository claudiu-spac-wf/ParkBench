import { currentQueryEvidence } from "./query-evidence";
import type { MetricSample } from "../../contracts/src/metrics";
import { physicalIdentity } from "./resource-membership";

export const CADVISOR_DISK_SNAPSHOT_PROFILE = "cadvisor-complete-disk-frame.v1";
export const usesCadvisorDiskSnapshots = (run: { environmentSnapshot?: Record<string, unknown> }) =>
  (run.environmentSnapshot?.sourceCadences as Record<string, unknown> | undefined)
    ?.cadvisorDiskAccountingProfile === CADVISOR_DISK_SNAPSHOT_PROFILE;

const definitions: Record<string, { operation: string; bytes: boolean; definitionId: string }> = {
  container_fs_reads_bytes_total: {
    operation: "Read",
    bytes: true,
    definitionId: "disk.read.bytes"
  },
  container_fs_writes_bytes_total: {
    operation: "Write",
    bytes: true,
    definitionId: "disk.write.bytes"
  },
  container_fs_reads_total: {
    operation: "Read",
    bytes: false,
    definitionId: "disk.read.operations"
  },
  container_fs_writes_total: {
    operation: "Write",
    bytes: false,
    definitionId: "disk.write.operations"
  }
};
export interface DiskSnapshotGap {
  reason: "unproved_disk_snapshot";
  metricName: string;
  physicalId: string;
  timestamp: number;
}
export interface DiskSnapshotFrame {
  physicalId: string;
  metricName: string;
  timestamp: number;
  sourceSampleCount: number;
  expectedDeviceCount: number;
}
const owner = (p: MetricSample) =>
  JSON.stringify([
    physicalIdentity(p),
    p.labels.job,
    p.labels.run_id,
    p.labels.container_label_parkbench_run_id,
    p.labels.service
  ]);

/** Opt-in, pinned cAdvisor/cgroup-v2 whole-snapshot accounting. The independent
 * major/minor Read+Write family enumerates the same native DiskIo frame. Missing
 * inventory, collisions or disagreement never authorize an aggregate or zero.
 * Call after ordinary ownership/source preference/deduplication accounting. */
export function accountCadvisorDiskSnapshots(
  input: MetricSample[],
  inventory: MetricSample[]
): {
  samples: MetricSample[];
  gaps: DiskSnapshotGap[];
  frames: DiskSnapshotFrame[];
} {
  const native = new Map<string, MetricSample[]>();
  const nativeTimes = new Map<string, Set<number>>();
  for (const sample of inventory) {
    if (
      sample.metricName !== "container_blkio_device_usage_total" ||
      !["Read", "Write"].includes(sample.labels.operation) ||
      !physicalIdentity(sample)
    )
      continue;
    const ownerKey = owner(sample);
    const times = nativeTimes.get(ownerKey) ?? new Set<number>();
    times.add(sample.timestamp);
    nativeTimes.set(ownerKey, times);
    const key = JSON.stringify([ownerKey, sample.timestamp]);
    const rows = native.get(key) ?? [];
    rows.push(sample);
    native.set(key, rows);
  }
  const groups = new Map<string, MetricSample[]>(),
    passthrough: MetricSample[] = [];
  for (const sample of input) {
    if (!definitions[sample.metricName]) {
      passthrough.push(sample);
      continue;
    }
    const key = JSON.stringify([owner(sample), sample.metricName]);
    const rows = groups.get(key) ?? [];
    rows.push(sample);
    groups.set(key, rows);
  }
  const samples = [...passthrough],
    gaps: DiskSnapshotGap[] = [],
    frames: DiskSnapshotFrame[] = [];
  for (const rows of groups.values()) {
    const byTime = new Map<number, MetricSample[]>();
    for (const row of rows) {
      const points = byTime.get(row.timestamp) ?? [];
      points.push(row);
      byTime.set(row.timestamp, points);
    }
    const groupOwner = owner(rows[0]);
    for (const timestamp of nativeTimes.get(groupOwner) ?? []) {
      if (!byTime.has(timestamp)) byTime.set(timestamp, []);
    }
    const derived: MetricSample[] = [],
      validFrames: DiskSnapshotFrame[] = [];
    const previous = new Map<string, { value: number; epoch: string | undefined }>();
    let epoch = 0,
      failed = false;
    for (const [timestamp, points] of [...byTime].sort(([a], [b]) => a - b)) {
      const first = points[0] ?? rows[0],
        definition = definitions[first.metricName];
      const evidence = native.get(JSON.stringify([owner(first), timestamp])) ?? [];
      const devices = new Map<string, Map<string, MetricSample>>();
      let valid = !!physicalIdentity(first) && evidence.length > 0;
      for (const p of evidence) {
        if (
          !/^\d+$/.test(p.labels.major ?? "") ||
          !/^\d+$/.test(p.labels.minor ?? "") ||
          !Number.isFinite(p.value) ||
          p.value < 0
        ) {
          valid = false;
          continue;
        }
        const key = `${p.labels.major}:${p.labels.minor}`;
        const operations = devices.get(key) ?? new Map<string, MetricSample>();
        const old = operations.get(p.labels.operation);
        if (old && (old.value !== p.value || old.labels.device !== p.labels.device)) valid = false;
        operations.set(p.labels.operation, p);
        devices.set(key, operations);
      }
      const expected = new Map<string, MetricSample>();
      for (const operations of devices.values()) {
        const read = operations.get("Read"),
          write = operations.get("Write");
        if (!read || !write || read.labels.device !== write.labels.device) {
          valid = false;
          continue;
        }
        const entry = operations.get(definition.operation)!;
        const device = entry.labels.device ?? "";
        // Different major/minor identities with the same display label cannot be joined.
        if (expected.has(device)) valid = false;
        expected.set(device, entry);
      }
      const values = new Map<string, MetricSample>();
      for (const p of points) {
        const device = p.labels.device ?? "",
          old = values.get(device);
        if (
          !Number.isFinite(p.value) ||
          p.value < 0 ||
          (old &&
            (old.value !== p.value || old.labels.accounting_epoch !== p.labels.accounting_epoch))
        )
          valid = false;
        values.set(device, p);
      }
      if (values.size !== expected.size || !expected.size) valid = false;
      for (const [device, p] of values) {
        const required = expected.get(device);
        if (!required || (definition.bytes && required.value !== p.value)) valid = false;
      }
      if (!valid) {
        failed = true;
        gaps.push({
          reason: "unproved_disk_snapshot",
          metricName: first.metricName,
          physicalId: physicalIdentity(first) ?? "native",
          timestamp
        });
        continue;
      }
      const identityValues = new Map<string, MetricSample>(
        [...values].map(([device, point]) => {
          const nativeDevice = expected.get(device)!;
          return [`${nativeDevice.labels.major}:${nativeDevice.labels.minor}`, point] as const;
        })
      );
      // A birth contributes its real first cumulative value to the group counter.
      // Existing resets, source-epoch changes and disappearance remain epoch edges.
      if (
        [...previous.keys()].some((device) => !identityValues.has(device)) ||
        [...identityValues].some(([device, p]) => {
          const old = previous.get(device);
          return old && (p.value < old.value || p.labels.accounting_epoch !== old.epoch);
        })
      )
        epoch++;
      previous.clear();
      for (const [device, p] of identityValues)
        previous.set(device, { value: p.value, epoch: p.labels.accounting_epoch });
      derived.push({
        ...first,
        value: [...values.values()].reduce((n, p) => n + p.value, 0),
        labels: {
          ...first.labels,
          device: "total",
          accounting_epoch: JSON.stringify([owner(first), "native-disk-frame.v1", epoch])
        }
      });
      validFrames.push({
        physicalId: physicalIdentity(first)!,
        metricName: first.metricName,
        timestamp,
        sourceSampleCount: points.length,
        expectedDeviceCount: expected.size
      });
    }
    const context = currentQueryEvidence();
    const cadenceMs = context?.scrapeCadenceMs ?? context?.nativeCadenceMs;
    if (context?.recordStatistics && Number.isFinite(cadenceMs) && cadenceMs! > 0) {
      try {
        context.recordStatistics({
          contractVersion: "measurement-statistics-decision.v1",
          startMs: context.requestedStartMs,
          endMs: context.requestedEndMs,
          cadenceMs: cadenceMs!,
          physicalId: physicalIdentity(rows[0]) ?? null,
          storedObservations: rows.length,
          scope: {
            definitionIds: [definitions[rows[0].metricName].definitionId],
            group:
              rows[0].labels.service === "database"
                ? "database"
                : /^pas(-[0-9]+)?$/.test(rows[0].labels.service)
                  ? "pas"
                  : "platform",
            coverageScope: "resource",
            dimensions: {
              direction: definitions[rows[0].metricName].operation === "Read" ? "read" : "write"
            }
          },
          reasonCodes: [
            failed ? "cadvisor_disk_snapshot_unproved" : "cadvisor_complete_disk_snapshot"
          ],
          counts: {
            rawSourceObservations: rows.length,
            validatedSourceObservations: validFrames.reduce((n, f) => n + f.sourceSampleCount, 0),
            expectedNativeDeviceObservations: validFrames.reduce(
              (n, f) => n + f.expectedDeviceCount,
              0
            ),
            derivedCgroupFrames: failed ? 0 : derived.length,
            unprovedFrames: gaps.filter(
              (g) =>
                g.physicalId === physicalIdentity(rows[0]) && g.metricName === rows[0].metricName
            ).length
          }
        });
      } catch {
        context.reportLoss?.("disk_snapshot_evidence_failed");
      }
    }
    // Preserve healthy partial source values if even one frame cannot be proved.
    samples.push(...(failed ? rows : derived));
    frames.push(...validFrames);
  }
  return { samples, gaps, frames };
}

/** Count real per-device readings separately from derived cgroup frames.
 * Availability starts/stops at the independent complete native inventory frames;
 * the cadence rule is applied to those intervals, never to returned FS row counts. */
export function cadvisorDiskSnapshotAcquisitionCounts(
  inventory: MetricSample[],
  source: MetricSample[],
  members: Array<{ physicalId: string; activeIntervals: Array<{ start: number; end: number }> }>,
  window: { start: number; end: number },
  cadence: number
): { expected: number; observed: number } {
  const frames = new Map<string, Map<number, Map<string, Set<string>>>>();
  const selectedOwners = new Set(source.map(owner));
  for (const p of inventory) {
    if (selectedOwners.size && !selectedOwners.has(owner(p))) continue;
    const id = physicalIdentity(p);
    if (
      !id ||
      !["Read", "Write"].includes(p.labels.operation) ||
      !/^\d+$/.test(p.labels.major ?? "") ||
      !/^\d+$/.test(p.labels.minor ?? "")
    )
      continue;
    const times = frames.get(id) ?? new Map(),
      devices = times.get(p.timestamp) ?? new Map();
    const key = `${p.labels.major}:${p.labels.minor}`,
      directions = devices.get(key) ?? new Set();
    directions.add(p.labels.operation);
    devices.set(key, directions);
    times.set(p.timestamp, devices);
    frames.set(id, times);
  }
  let expected = 0;
  for (const member of members)
    for (const interval of member.activeIntervals) {
      const start = Math.max(window.start, interval.start),
        end = Math.min(window.end, interval.end);
      if (end <= start) continue;
      const times = [...(frames.get(member.physicalId) ?? new Map()).entries()]
        .filter(([t]) => t >= start && t <= end)
        .sort(([a], [b]) => a - b);
      const active = new Map<string, number>();
      const finish = (device: string, until: number) => {
        const since = active.get(device)!;
        expected += Math.max(0, Math.ceil((until - since) / cadence - 1e-8));
        active.delete(device);
      };
      if (!times.length) {
        expected += Math.ceil((end - start) / cadence - 1e-8);
        continue;
      }
      let first = true;
      for (const [timestamp, devices] of times) {
        const available = new Set<string>();
        for (const [device, operations] of devices)
          if (operations.has("Read") && operations.has("Write")) available.add(device);
        for (const device of [...active.keys()])
          if (!available.has(device)) finish(device, timestamp);
        for (const device of available)
          if (!active.has(device)) active.set(device, first ? start : timestamp);
        first = false;
      }
      for (const device of [...active.keys()]) finish(device, end);
    }
  const observed = source.filter(
    (p) =>
      p.timestamp >= window.start &&
      p.timestamp < window.end &&
      members.some(
        (m) =>
          physicalIdentity(p) === m.physicalId &&
          m.activeIntervals.some((i) => p.timestamp >= i.start && p.timestamp < i.end)
      )
  ).length;
  return { expected, observed };
}
