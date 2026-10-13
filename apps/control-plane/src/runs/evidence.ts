import { ArtifactStorage } from "../artifacts/storage";
import { artifactRecord } from "../artifacts/manifest";
import { Repositories } from "../db/repositories";
import { Run } from "../../../../packages/contracts/src/run";
import {
  RunEvidence,
  HostEnvironmentEvidenceReference,
  ObserverCompletenessEvidence,
  ObserverMetricEvidence,
  RUN_EVIDENCE_CONTRACT_VERSION
} from "../../../../packages/contracts/src/run-evidence";
import { MetricSample, MetricSummary } from "../../../../packages/contracts/src/metrics";
import { OPENEDGE_WORKLOAD_TIMEOUT_MS } from "../../../../packages/contracts/src/openedge";
import {
  OPENEDGE_DB_AVAILABILITY_VALUES,
  OPENEDGE_DB_FAMILY_NAMES,
  OPENEDGE_DB_FAMILY_SOURCES,
  OPENEDGE_DB_METRIC_CATALOG,
  OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION,
  OpenEdgeDbAvailability
} from "../../../../packages/contracts/src/openedge";
import fs from "node:fs";

/**
 * Writes run-evidence.v2. `measurementSamples` are the run's measurement-window samples read
 * back from Prometheus by the finalizer; without them the evidence has no `openedgeDb` block.
 */
export function persistRunEvidence(
  run: Run,
  storage: ArtifactStorage,
  repositories: Repositories,
  measurementSamples: MetricSample[] = []
): RunEvidence {
  const snapshot = (run.environmentSnapshot ?? {}) as Record<string, any>;
  const scenario = snapshot.scenario ?? {};
  const inputs = snapshot.inputs ?? {};
  const resolved = snapshot.resolvedImages ?? {};
  const artifacts = repositories.listArtifacts(run.id);
  const summaryArtifacts = artifacts
    .filter((artifact) => artifact.kind === "load_summary")
    .map((artifact) => readJson(storage, artifact.path));
  const metricSummary = summaryArtifacts.find(
    (candidate) =>
      Array.isArray(candidate?.summaries) &&
      candidate.summaries.some((item: any) => typeof item?.metricName === "string" && item.labels)
  );
  const workloadSummary = summaryArtifacts.find(
    (candidate) => candidate?.requests && typeof candidate.requests === "object"
  );
  const summary =
    metricSummary || workloadSummary
      ? {
          ...metricSummary,
          ...workloadSummary,
          ...(metricSummary?.summaries ? { summaries: metricSummary.summaries } : {})
        }
      : (run.summary ?? {});
  const metricSummaries = metricSummaryValues(summary);
  const completeness = Array.isArray(run.completeness?.evidence)
    ? run.completeness.evidence.filter(
        (entry): entry is ObserverCompletenessEvidence =>
          typeof entry?.observerId === "string" && typeof entry.phase === "string"
      )
    : [];
  const operation = scenario.workload?.operations?.find(
    (candidate: any) => candidate.method === "POST" && candidate.path === "/work"
  );
  const requestCount =
    Number(summary?.requests?.completed ?? 0) + Number(summary?.requests?.errors ?? 0);
  const timeoutObservations = Array.isArray(summary?.timeoutObservations)
    ? summary.timeoutObservations
    : [];
  const measurementSummaries = metricSummaries.filter((item) => item.phase === "measurement");
  const throughputSummary = measurementSummaries.find(
    (item) => item.metricName === "parkbench_workload_throughput_per_second"
  );
  const latencySummary = measurementSummaries.find(
    (item) => item.metricName === "parkbench_workload_request_duration_seconds"
  );
  const resources = repositories.listResources(run.id);
  const manifestPath =
    snapshot.openedgeImageManifestPath ?? process.env.PARKBENCH_OPENEDGE_IMAGE_MANIFEST;
  const imageBuildManifest =
    manifestPath && fs.existsSync(manifestPath)
      ? {
          path: manifestPath,
          imageStage: "final" as const,
          parkBenchReady: true as const
        }
      : undefined;
  const evidence: RunEvidence = {
    contractVersion: RUN_EVIDENCE_CONTRACT_VERSION,
    runId: run.id,
    experimentId: run.experimentId,
    variantId: run.variantId,
    scenario: {
      id: scenario.id ?? "unknown",
      version: scenario.version ?? "unknown"
    },
    inputs: {
      databaseImage: String(inputs.databaseImage ?? resolved.database?.reference ?? ""),
      pasImage: String(inputs.pasImage ?? resolved.pas?.reference ?? ""),
      observerImage: String(resolved.observer?.reference ?? ""),
      imageBuildManifest,
      imageStage: imageBuildManifest?.imageStage,
      parkBenchReady: imageBuildManifest?.parkBenchReady,
      seed: inputs.seed
        ? {
            path: String(inputs.seed),
            ...(inputs.seedName ? { name: String(inputs.seedName) } : {}),
            ...(inputs.databaseName ? { databaseName: String(inputs.databaseName) } : {}),
            ...(Number.isFinite(snapshot.seedCopySeconds)
              ? { copySeconds: Number(snapshot.seedCopySeconds) }
              : {})
          }
        : undefined,
      applicationArchive: inputs.applicationArchive
        ? { path: String(inputs.applicationArchive) }
        : undefined
    },
    imageIdentity: Object.fromEntries(
      Object.entries(run.imageSnapshots ?? snapshot.resolvedImages ?? {}).map(([key, value]) => {
        const image = value as Record<string, unknown>;
        return [
          key,
          {
            configuredReference: String(image.configuredReference ?? image.reference ?? ""),
            identityStrength: "tag" as const
          }
        ];
      })
    ),
    effectiveConfiguration: {
      values: snapshot.effectiveConfiguration ?? {},
      adapterVersion: String(snapshot.parameterAdapterVersion ?? "parameters.v1")
    },
    databaseStartup: snapshot.databaseStartup,
    ...(snapshot.databaseLatency ? { databaseLatency: snapshot.databaseLatency } : {}),
    parameterSnapshotCapture: snapshot.parameterSnapshotCapture ?? {
      state: "not_captured",
      reasonCode:
        run.state === "CANCELLED"
          ? "run_cancelled"
          : run.failureCode?.startsWith("database_readiness")
            ? "database_not_ready"
            : run.failureKind === "observer"
              ? "observer_unavailable"
              : "preflight_failed"
    },
    parameterSnapshotTelemetry: snapshot.parameterSnapshotTelemetry,
    deterministicLoadSeed: Number(
      snapshot.effectiveConfiguration?.["workload.seed"] ?? snapshot.deterministicLoadSeed ?? 1
    ),
    hostDocker: hostDockerEvidence(snapshot.hostDocker),
    phaseBoundaries: run.phaseBoundaries ?? {},
    workload: {
      selectedProcedure: operation?.bodyTemplate?.procName,
      requests: requestCount,
      successes: Number(summary?.requests?.completed ?? 0),
      failures: Number(summary?.applicationErrorCount ?? summary?.requests?.errors ?? 0),
      timeoutCount: Number(summary?.timeoutCount ?? 0),
      timeoutMs: Number(summary?.timeoutMs || OPENEDGE_WORKLOAD_TIMEOUT_MS),
      timeoutObservations: timeoutObservations.map((observation: any) => ({
        requestId: observation.requestId,
        procName: operation?.bodyTemplate?.procName,
        elapsedMs: Math.max(OPENEDGE_WORKLOAD_TIMEOUT_MS, Number(observation.elapsedMs ?? 0)),
        latencyObservation: "lower_bound" as const
      })),
      phaseResults: summary?.phaseResults,
      errorSamples: summary?.errorSamples,
      throughputPerSecond: throughputSummary?.mean,
      latencySeconds: latencySummary
        ? {
            p50: latencySummary.p50,
            p95: latencySummary.p95,
            p99: latencySummary.p99
          }
        : undefined
    },
    observers: {
      health: run.observerHealth ?? {},
      completeness: (run.completeness ?? {}) as Record<string, unknown>,
      diskIo: {
        container: metricEvidence(
          metricSummaries.filter((item) => item.metricName.startsWith("parkbench_container_disk_")),
          completeness.filter((item) => item.observerId.startsWith("disk-io-cadvisor")),
          "cadvisor"
        ),
        host: metricEvidence(
          metricSummaries.filter((item) => item.metricName.startsWith("parkbench_host_disk_")),
          completeness.filter((item) => item.observerId.startsWith("disk-io-node-exporter")),
          "node-exporter:block-device"
        )
      },
      files: metricEvidence(
        metricSummaries.filter((item) => item.metricName.startsWith("parkbench_file_")),
        completeness.filter(
          (item) => item.observerId === "files" || item.observerId.startsWith("file-")
        ),
        "file-sampler"
      )
    },
    openedgeDb: openEdgeDbEvidence(measurementSamples, run.id, inputs, resolved),
    metrics: snapshot.metrics?.source === "prometheus" ? snapshot.metrics : null,
    cleanup: {
      status: run.cleanupStatus,
      ownedResources: resources
        .filter((resource) => resource.labels?.["parkbench.run_id"] === run.id)
        .map((resource) => String(resource.resourceId)),
      ownershipVerified: resources.every(
        (resource) => resource.labels?.["parkbench.run_id"] === run.id
      )
    }
  };
  const file = storage.write(`${run.id}/run-evidence.json`, JSON.stringify(evidence, null, 2));
  repositories.saveArtifact(artifactRecord(run.id, "run_evidence", file, "json"));
  return evidence;
}

// The evidence file keeps a bounded view of the OpenEdge series; Prometheus keeps them all.
const OPENEDGE_EVIDENCE_SAMPLE_LIMIT = 2_000;
const OPENEDGE_EVIDENCE_AVAILABILITY_LIMIT = 8_192;

function openEdgeDbEvidence(
  measurementSamples: MetricSample[],
  runId: string,
  inputs: Record<string, any>,
  resolved: Record<string, any>
): NonNullable<RunEvidence["openedgeDb"]> | undefined {
  const protocolVersion = measurementSamples.some((s) =>
    s.metricName.startsWith("parkbench_openedge_db_latch_named_")
  )
    ? 4
    : 3;
  const catalog = OPENEDGE_DB_METRIC_CATALOG.filter(
    (d) => (d.sinceProtocol ?? 2) <= protocolVersion
  );
  const samples: MetricSample[] = [];
  const availabilityByKey = new Map<
    string,
    NonNullable<RunEvidence["openedgeDb"]>["availability"][number]
  >();
  const metricNames = new Set<string>();
  const databaseEpochs = new Set<string>();
  let sampleCount = 0;
  let availabilityTruncated = false;
  for (const sample of measurementSamples) {
    if (!sample.metricName.startsWith("parkbench_openedge_db_") || sample.labels.run_id !== runId)
      continue;
    sampleCount += 1;
    if (samples.length < OPENEDGE_EVIDENCE_SAMPLE_LIMIT) samples.push(sample);
    if (sample.labels.database_epoch) databaseEpochs.add(sample.labels.database_epoch);
    if (sample.metricName !== "parkbench_openedge_db_metric_available") {
      metricNames.add(sample.metricName.slice("parkbench_openedge_db_".length));
      continue;
    }
    const entry = availabilityEntry(sample);
    if (!entry) continue;
    const key = JSON.stringify([
      entry.family,
      entry.measurement,
      entry.reason,
      entry.value,
      entry.labels
    ]);
    if (availabilityByKey.has(key)) continue;
    if (availabilityByKey.size >= OPENEDGE_EVIDENCE_AVAILABILITY_LIMIT)
      availabilityTruncated = true;
    else availabilityByKey.set(key, entry);
  }
  if (sampleCount === 0) return undefined;

  const sourceImageReference = String(
    inputs.databaseImage ??
      resolved.database?.configuredReference ??
      resolved.database?.reference ??
      ""
  );
  const patchIdentity = String(
    inputs.databaseProductPatch ?? resolved.database?.productPatch ?? sourceImageReference
  );
  const availability = [...availabilityByKey.values()];

  return {
    contractVersion: "openedge-db-evidence.v1",
    protocolVersion,
    productPatch: parseOpenEdgePatch(patchIdentity),
    sourceImageReference,
    families: OPENEDGE_DB_FAMILY_NAMES.map((name) => ({
      name,
      sources: [...OPENEDGE_DB_FAMILY_SOURCES[name]],
      measurements: catalog.filter((entry) => entry.family === name).map((entry) => entry.name)
    })),
    measurementSources: OPENEDGE_DB_METRIC_CATALOG.map((entry) => ({
      family: entry.family,
      measurement: entry.name,
      sources: [...entry.sources],
      sourceFields: [...entry.sourceFields]
    })),
    availability,
    availabilityTruncated,
    databaseEpochs: [...databaseEpochs].sort(),
    metricNames: [...metricNames].sort(),
    sampleCount,
    samples,
    samplesTruncated: sampleCount > samples.length
  };
}

function availabilityEntry(
  sample: MetricSample
): NonNullable<RunEvidence["openedgeDb"]>["availability"][number] | undefined {
  const family = sample.labels.family;
  const measurement = sample.labels.measurement;
  const reason = sample.labels.reason;
  if (
    !family ||
    !OPENEDGE_DB_FAMILY_NAMES.includes(family as (typeof OPENEDGE_DB_FAMILY_NAMES)[number]) ||
    !measurement ||
    !OPENEDGE_DB_METRIC_CATALOG.some((entry) => entry.name === measurement) ||
    !reason
  )
    return undefined;
  const status = availabilityStatus(reason, sample.value);
  if (!status) return undefined;
  return {
    family,
    measurement,
    availability: status,
    reason,
    source: sample.source,
    labels: boundedAvailabilityLabels(sample.labels),
    value: sample.value === 1 ? 1 : 0
  };
}

function availabilityStatus(reason: string, value: number): OpenEdgeDbAvailability | undefined {
  if (value === 1) return reason === "available" ? "available" : undefined;
  if (value !== 0) return undefined;
  const byReason: Record<string, OpenEdgeDbAvailability> = {
    vst_missing: "unsupported",
    field_missing: "unsupported",
    alternate_pool_disabled: "not_configured",
    statistics_range_excludes_object: "not_configured",
    statistics_disabled: "not_configured",
    source_disabled: "not_configured",
    license_required: "not_licensed",
    not_applicable: "not_collected",
    collection_timeout: "temporarily_unavailable",
    collection_error: "temporarily_unavailable"
  };
  const status = byReason[reason];
  return status && OPENEDGE_DB_AVAILABILITY_VALUES.includes(status) ? status : undefined;
}

function boundedAvailabilityLabels(labels: Record<string, string>): Record<string, string> {
  const allowed = new Set([
    "experiment_id",
    "run_id",
    "variant_id",
    "repetition",
    "component",
    "service",
    "phase",
    "pool",
    "operation",
    "table",
    "index",
    "database_epoch"
  ]);
  return Object.fromEntries(Object.entries(labels).filter(([key]) => allowed.has(key)));
}

function parseOpenEdgePatch(value: string): string | null {
  return value.match(/\b(12\.8\.\d+)\b/)?.[1] ?? null;
}

function hostDockerEvidence(input: unknown): RunEvidence["hostDocker"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const metadata = { ...(input as Record<string, unknown>) };
  const reference = sanitizeHostEnvironmentReference(metadata.hostEnvironment);
  delete metadata.hostEnvironment;
  return { ...metadata, ...(reference ? { hostEnvironment: reference } : {}) };
}

function sanitizeHostEnvironmentReference(
  input: unknown
): HostEnvironmentEvidenceReference | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, any>;
  if (
    value.contractVersion !== "host-environment.v1" ||
    value.rootSetting !== "PARKBENCH_HOST_DATA_ROOT" ||
    !safeProfilePath(value.path) ||
    !validUtcTimestamp(value.capturedAt) ||
    typeof value.engine?.reachable !== "boolean"
  )
    return undefined;
  const nullableSafeString = (candidate: unknown): string | null =>
    typeof candidate === "string" &&
    candidate.length <= 128 &&
    /^[A-Za-z0-9._ +:/-]+$/.test(candidate)
      ? candidate
      : null;
  return {
    contractVersion: "host-environment.v1",
    path: value.path,
    rootSetting: "PARKBENCH_HOST_DATA_ROOT",
    capturedAt: value.capturedAt,
    host: {
      osId: nullableSafeString(value.host?.osId),
      osRelease: nullableSafeString(value.host?.osRelease),
      codename: nullableSafeString(value.host?.codename),
      kernel: nullableSafeString(value.host?.kernel),
      architecture: nullableSafeString(value.host?.architecture)
    },
    toolchain: {
      node: nullableSafeString(value.toolchain?.node),
      npm: nullableSafeString(value.toolchain?.npm),
      dockerClient: nullableSafeString(value.toolchain?.dockerClient),
      compose: nullableSafeString(value.toolchain?.compose),
      compilerAdapterVersion: nullableSafeString(value.toolchain?.compilerAdapterVersion)
    },
    engine: {
      reachable: value.engine.reachable,
      contextName: nullableSafeString(value.engine.contextName),
      serverVersion: nullableSafeString(value.engine.serverVersion),
      operatingSystem: nullableSafeString(value.engine.operatingSystem),
      architecture: nullableSafeString(value.engine.architecture)
    }
  };
}

function safeProfilePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith("/") &&
    !value.split("/").includes("..")
  );
}

function validUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function readJson(storage: ArtifactStorage, file: string): any {
  try {
    return JSON.parse(storage.read(file).toString("utf8"));
  } catch {
    return {};
  }
}

function metricSummaryValues(summary: any): MetricSummary[] {
  return Array.isArray(summary?.summaries)
    ? summary.summaries.filter(
        (candidate: any): candidate is MetricSummary =>
          candidate && typeof candidate.metricName === "string" && candidate.labels
      )
    : [];
}

function metricEvidence(
  summaries: MetricSummary[],
  completeness: ObserverCompletenessEvidence[],
  source: string
): ObserverMetricEvidence {
  return {
    sampleCount: summaries.reduce(
      (total, summary) => total + Number(summary.observedSamples ?? summary.count ?? 0),
      0
    ),
    metricNames: [...new Set(summaries.map((summary) => summary.metricName))].sort(),
    sources: summaries.length ? [source] : [],
    summaries,
    completeness
  };
}
