import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  measurementStatistics
} = require("../../dist/packages/metrics/src/measurement-statistics.js");
const diskDefinitions = new Set([
  "disk.read.bytes",
  "disk.write.bytes",
  "disk.read.operations",
  "disk.write.operations"
]);
const near = (a, b) =>
  Number.isFinite(a) &&
  Number.isFinite(b) &&
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

// This proves source unavailability. It never creates disk observations or changes
// a saved value, count, coverage, status, physical membership or quality policy.
export function proveEmptyDiskAccounting(records, options) {
  const {
    runId,
    member,
    startMs,
    endMs,
    cadenceMs,
    housekeepingMs,
    expectedImageId,
    evidenceRef,
    sourceProfile
  } = options;
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    endMs <= startMs ||
    !/^sha256:[a-f0-9]{64}$/.test(expectedImageId ?? "") ||
    sourceProfile !== "cadvisor-complete-disk-frame.v1" ||
    member?.group !== "platform" ||
    !/^\/docker\/[a-f0-9]{64}$/.test(member.physicalId ?? "") ||
    !Number.isFinite(cadenceMs) ||
    cadenceMs <= 0 ||
    !Number.isFinite(housekeepingMs) ||
    housekeepingMs <= 0 ||
    !evidenceRef
  )
    return null;
  if (
    records.some(
      (r) =>
        r.service === "discovery" &&
        r.state === "UNAVAILABLE" &&
        r.readStartedAtMs < endMs &&
        r.readFinishedAtMs >= startMs
    )
  )
    return null;
  const edge = cadenceMs + 2 * housekeepingMs,
    id = member.physicalId.split("/").at(-1),
    scoped = records.filter(
      (r) =>
        r.service === member.service &&
        r.readFinishedAtMs >= startMs - edge &&
        r.readStartedAtMs <= endMs + edge
    );
  if (scoped.length < 2) return null;
  for (const r of scoped) {
    const at = Date.parse(r.cadvisor?.capturedAt);
    if (
      r.runId !== runId ||
      r.containerId !== id ||
      r.imageId !== expectedImageId ||
      r.state !== "COMPLETE" ||
      r.kernelOwnerConfirmed !== true ||
      !Number.isSafeInteger(r.readStartedAtMs) ||
      !Number.isSafeInteger(r.readFinishedAtMs) ||
      r.readFinishedAtMs < r.readStartedAtMs ||
      !Array.isArray(r.kernelDevices) ||
      r.kernelDevices.length !== 0 ||
      r.cadvisor?.hasDiskIo !== true ||
      !Number.isFinite(at) ||
      at > r.readFinishedAtMs + 1 ||
      at < r.readStartedAtMs - 2 * housekeepingMs - 1 ||
      !["io_service_bytes", "io_serviced"].every(
        (k) =>
          Array.isArray(r.cadvisor.deviceFamilies?.[k]) && r.cadvisor.deviceFamilies[k].length === 0
      )
    )
      return null;
  }
  const inside = scoped
    .filter((r) => r.readStartedAtMs >= startMs && r.readFinishedAtMs <= endMs)
    .sort((a, b) => a.readStartedAtMs - b.readStartedAtMs);
  if (
    inside.length < 2 ||
    inside[0].readFinishedAtMs - startMs > edge ||
    endMs - inside.at(-1).readStartedAtMs > edge ||
    inside
      .slice(1)
      .some((r, i) => r.readFinishedAtMs - inside[i].readStartedAtMs > 1.5 * cadenceMs + 1)
  )
    return null;
  const nativeTimes = [...new Set(scoped.map((r) => Date.parse(r.cadvisor.capturedAt)))].sort(
    (a, b) => a - b
  );
  const sourceCoverage = measurementStatistics(
    [
      {
        cadenceSeconds: cadenceMs / 1000,
        acquisitionLagSeconds: (2 * housekeepingMs) / 1000,
        observations: nativeTimes.map((t) => ({ timestamp: t / 1000, value: 0 }))
      }
    ],
    { start: startMs / 1000, end: endMs / 1000 },
    { type: "gauge", unit: "native_device_count" }
  ).coverage;
  if (sourceCoverage.missingSeconds > 1e-8) return null;
  return {
    contractVersion: "measurement-source-availability-proof.v1",
    runId,
    physicalId: member.physicalId,
    service: member.service,
    imageId: expectedImageId,
    startMs,
    endMs,
    reasonCode: "native_disk_accounting_empty",
    evidenceRef,
    sourceProfile,
    kernelObservations: inside.length,
    nativeObservations: nativeTimes.length,
    maxKernelObservationSeparationMs: Math.max(
      ...inside.slice(1).map((r, i) => r.readFinishedAtMs - inside[i].readStartedAtMs)
    ),
    sourceCoverage,
    interpretation:
      "Successful owned kernel io.stat reads and typed native frames contain no accountable devices. Disk values remain unavailable; no zero disk reading is inferred."
  };
}
export function explainPlatformDiskLimitation(original, contribution, proofs, memberships) {
  if (
    original?.group !== "platform" ||
    !diskDefinitions.has(original.definitionId) ||
    contribution?.rowKey !== original.rowKey ||
    !proofs.length
  )
    return null;
  const platform = memberships.filter((m) => m.group === "platform"),
    ids = new Set(proofs.map((p) => p.physicalId));
  if (
    ids.size !== proofs.length ||
    !proofs.every(
      (p) =>
        p.reasonCode === "native_disk_accounting_empty" &&
        p.sourceCoverage?.missingSeconds === 0 &&
        p.sourceCoverage.durationSeconds === original.coverage.durationSeconds &&
        (p.endMs - p.startMs) / 1000 === original.coverage.durationSeconds &&
        platform.some((m) => m.physicalId === p.physicalId && m.service === p.service)
    )
  )
    return null;
  if (
    contribution.coverage.missingSeconds > 1e-8 ||
    Object.values(contribution.statistics).some(
      (s) => s.value === null || s.status === "partial" || s.status === "unavailable"
    ) ||
    original.coverage.missingSeconds !== original.coverage.durationSeconds ||
    !original.coverage.reasons?.includes("required_member_missing") ||
    original.coverage.observedAcquisitions !== contribution.coverage.observedAcquisitions
  )
    return null;
  const total = original.statistics.total,
    healthy = contribution.statistics.total;
  if (
    !total ||
    !healthy ||
    total.status !== "partial" ||
    !near(total.value, healthy.value) ||
    !near(total.observedTotal, healthy.observedTotal) ||
    !near(total.estimatedTotal, healthy.estimatedTotal) ||
    total.coverage?.supportedContributors !== platform.length - ids.size ||
    total.coverage?.incompleteContributors !== ids.size
  )
    return null;
  return {
    rowKey: original.rowKey,
    classification: "LEGITIMATE_LIMITATION",
    reasonCode: "native_disk_accounting_empty",
    physicalIds: [...ids],
    evidenceRefs: proofs.map((p) => p.evidenceRef),
    preservedCoverage: original.coverage,
    preservedTotalStatus: total.status,
    supportedContributors: platform.length - ids.size,
    contributionCoverage: contribution.coverage,
    interpretation:
      "The saved shared-member statistics remain unavailable and the healthy additive contribution remains partial. Only the independently unavailable physical source is explained; all other contributors must be complete."
  };
}
export async function readDiskAvailabilityRecords(root, reference) {
  if (typeof reference !== "string" || !reference.endsWith(".jsonl"))
    throw Error("availability_reference_invalid");
  const base = await fs.realpath(root),
    file = path.resolve(base, reference);
  if (!file.startsWith(base + path.sep) || (await fs.realpath(file)) !== file)
    throw Error("availability_path_invalid");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 ** 2)
    throw Error("availability_file_invalid");
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  if (lines.length > 8192) throw Error("availability_record_limit");
  return lines.map((line) => {
    if (Buffer.byteLength(line) > 4096) throw Error("availability_event_limit");
    const r = JSON.parse(line);
    if (r.contractVersion !== "measurement-device-state.v1") throw Error("availability_version");
    return r;
  });
}

export async function auditEmptyPlatformDiskSources({
  prom,
  run,
  configuration,
  memberships,
  options,
  rows,
  availabilityEvidence
}) {
  if (!availabilityEvidence) return { proofs: [], limitations: [] };
  const records = await readDiskAvailabilityRecords(
      availabilityEvidence.root,
      availabilityEvidence.reference
    ),
    proofs = [],
    startMs = Date.parse(options.window.start),
    endMs = Date.parse(options.window.end);
  for (const member of memberships.filter((m) => m.group === "platform")) {
    const proof = proveEmptyDiskAccounting(records, {
      runId: run.id,
      member,
      startMs,
      endMs,
      cadenceMs: options.sourceStepSeconds * 1000,
      housekeepingMs: options.cadvisorHousekeepingSeconds * 1000,
      expectedImageId: configuration.deployedRefs[member.service],
      sourceProfile: run.environmentSnapshot?.sourceCadences?.cadvisorDiskAccountingProfile,
      evidenceRef: availabilityEvidence.reference
    });
    if (!proof) continue;
    const metrics = [
      "container_fs_reads_bytes_total",
      "container_fs_writes_bytes_total",
      "container_fs_reads_total",
      "container_fs_writes_total",
      "container_blkio_device_usage_total"
    ];
    let absent = true;
    for (const metric of metrics) {
      const points = await prom.queryRawRange(
        `${metric}{id=${JSON.stringify(member.physicalId)}}`,
        startMs / 1000,
        endMs / 1000,
        options.sourceStepSeconds
      );
      if (points.length) {
        absent = false;
        break;
      }
    }
    if (absent) proofs.push(proof);
  }
  if (!proofs.length) return { proofs: [], limitations: [] };
  const ids = new Set(proofs.map((p) => p.physicalId)),
    retained = memberships.filter((m) => !ids.has(m.physicalId)),
    {
      buildResourceSummaryRows
    } = require("../../dist/packages/metrics/src/measurement-summary.js");
  const referenceOptions = {
      ...options,
      memberships: retained,
      expectedMembers: retained.map((m) => ({
        group: m.group,
        service: m.service,
        ...(m.group === "pas" ? { replica: m.service } : {})
      })),
      queries: []
    },
    contributions = new Map();
  for await (const row of buildResourceSummaryRows(prom, referenceOptions))
    if (row.group === "platform" && diskDefinitions.has(row.definitionId))
      contributions.set(row.rowKey, row);
  const limitations = rows
    .map((row) =>
      explainPlatformDiskLimitation(row, contributions.get(row.rowKey), proofs, memberships)
    )
    .filter(Boolean);
  return { proofs, limitations };
}
