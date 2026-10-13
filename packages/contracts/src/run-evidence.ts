import type { DatabaseLatencyEvidence } from "./database-latency";
import { MetricSample, MetricSummary } from "./metrics";
import type { DatabaseStartupParameters } from "./database-startup";

export interface RunMetricsReferenceEvidence {
  contractVersion: "run-metrics-reference.v1";
  source: "prometheus";
  queries: string[];
  runWindow: { start: string; end: string };
  measurementState: "not_started" | "completed" | "interrupted";
  measurementWindow: { start: string; end: string } | null;
  stepSeconds: number;
  sampleCount: number;
  sources: string[];
  labelKeys: string[];
}

export const RUN_EVIDENCE_CONTRACT_VERSION = "run-evidence.v2" as const;

export interface ObserverCompletenessEvidence {
  observerId: string;
  phase: string;
  longestGapSeconds?: number;
  lastSuccessAt?: string;
}

export interface ObserverMetricEvidence {
  sampleCount: number;
  metricNames: string[];
  sources: string[];
  summaries: MetricSummary[];
  completeness: ObserverCompletenessEvidence[];
}

export interface HostEnvironmentEvidenceReference {
  contractVersion: "host-environment.v1";
  path: string;
  rootSetting: "PARKBENCH_HOST_DATA_ROOT";
  capturedAt: string;
  host: {
    osId: string | null;
    osRelease: string | null;
    codename: string | null;
    kernel: string | null;
    architecture: string | null;
  };
  toolchain: {
    node: string | null;
    npm: string | null;
    dockerClient: string | null;
    compose: string | null;
    compilerAdapterVersion: string | null;
  };
  engine: {
    reachable: boolean;
    contextName: string | null;
    serverVersion: string | null;
    operatingSystem: string | null;
    architecture: string | null;
  };
}

export interface RunEvidence {
  contractVersion: typeof RUN_EVIDENCE_CONTRACT_VERSION;
  runId: string;
  experimentId: string;
  variantId: string;
  scenario: {
    id: string;
    version: string;
  };
  inputs: {
    databaseImage: string;
    pasImage: string;
    observerImage: string;
    imageBuildManifest?: {
      path: string;
      imageStage: "final";
      parkBenchReady: true;
    };
    imageStage?: "final";
    parkBenchReady?: true;
    /**
     * Feature 014 records the seed's identity; earlier runs carry only { path }. `generation` and
     * `sourcePath` appear only on runs from before seeds became plain database folders.
     */
    seed?: {
      path: string;
      name?: string;
      generation?: string;
      sourcePath?: string;
      databaseName?: string;
      copySeconds?: number;
    };
    applicationArchive?: { path: string };
  };
  imageIdentity?: Record<
    string,
    {
      configuredReference: string;
      identityStrength: "tag";
    }
  >;
  effectiveConfiguration: {
    values: Record<string, unknown>;
    adapterVersion: string;
  };
  databaseStartup?: DatabaseStartupParameters;
  /** Database Latency evidence (feature 016); absent on runs recorded before it existed. */
  databaseLatency?: DatabaseLatencyEvidence;
  parameterSnapshotCapture?:
    | { state: "captured"; artifact: "db-parameter-snapshot.json" }
    | {
        state: "not_captured";
        reasonCode:
          | "preflight_failed"
          | "database_not_ready"
          | "observer_unavailable"
          | "observer_response_invalid"
          | "run_cancelled";
      };
  parameterSnapshotTelemetry?: { captureDurationSeconds: number; seriesCount: number };
  deterministicLoadSeed: number;
  hostDocker: Record<string, unknown> & {
    hostEnvironment?: HostEnvironmentEvidenceReference;
  };
  phaseBoundaries: Record<string, { startedAt: string; finishedAt?: string }>;
  workload: {
    selectedProcedure?: string;
    requests: number;
    successes: number;
    failures: number;
    timeoutCount: number;
    timeoutMs: number;
    timeoutObservations: Array<{
      requestId?: string;
      procName?: string;
      elapsedMs: number;
      latencyObservation: "lower_bound";
    }>;
    phaseResults?: Record<string, { requests: number; failures: number; timeoutCount: number }>;
    errorSamples?: Array<{
      operation: string;
      phase?: string;
      status?: number;
      error: string;
      timeout: boolean;
    }>;
    throughputPerSecond?: number;
    latencySeconds?: { p50?: number; p95?: number; p99?: number };
  };
  observerOverhead?: {
    mode: "observer_off" | "observer_on";
    pairedRunId: string;
    sharedLoadSeed: number;
    collectorDurationSeconds: { samples: number; mean?: number; p95?: number };
    observerResources: { cpuCoreSeconds?: number; peakMemoryBytes?: number };
    workload: {
      throughputPerSecond?: number;
      latencySeconds?: { p50?: number; p95?: number; p99?: number };
    };
  };
  observers: {
    health: Record<string, unknown>;
    completeness: Record<string, unknown>;
    diskIo: {
      container: ObserverMetricEvidence;
      host: ObserverMetricEvidence;
    };
    files: ObserverMetricEvidence;
  };
  openedgeDb?: {
    contractVersion: "openedge-db-evidence.v1";
    protocolVersion: 2 | 3 | 4;
    productPatch: string | null;
    sourceImageReference: string;
    families: Array<{ name: string; sources: string[]; measurements: string[] }>;
    measurementSources: Array<{
      family: string;
      measurement: string;
      sources: string[];
      sourceFields: string[];
    }>;
    availability: Array<{
      family: string;
      measurement: string;
      availability:
        | "available"
        | "unsupported"
        | "not_configured"
        | "not_licensed"
        | "not_collected"
        | "temporarily_unavailable";
      reason: string;
      source: string;
      labels: Record<string, string>;
      value: 0 | 1;
    }>;
    /** True when more distinct availability entries existed than the evidence keeps. */
    availabilityTruncated: boolean;
    databaseEpochs: string[];
    /** OpenEdge measurement names (without the `parkbench_openedge_db_` prefix) in the measurement window. */
    metricNames: string[];
    /** OpenEdge samples read back from Prometheus for the measurement window. */
    sampleCount: number;
    /** The first of those samples, bounded; Prometheus holds the full series. */
    samples: MetricSample[];
    samplesTruncated: boolean;
  };
  /**
   * Where the run's time series live (constitution 4.0.0): Prometheus, located by these queries
   * and windows. Null when the run ended before its metrics could be read.
   */
  metrics: RunMetricsReferenceEvidence | null;
  cleanup: {
    startedAt?: string;
    finishedAt?: string;
    status: string;
    ownedResources: string[];
    ownershipVerified: boolean;
  };
}
