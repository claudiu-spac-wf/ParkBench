import { checkReadableSeedDirectory } from "../../../../packages/compose-runner/src/input-checks";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createPlatform, testObserverFactory } from "../platform";
import { buildServer } from "../server";
import {
  validateRunContext,
  validateSummaryHeader
} from "../../../../packages/contracts/src/run-summary";
import { validateScenario } from "../../../../packages/contracts/src/validator";
import { validateVariant } from "../../../../packages/contracts/src/variant";
import { loadConfig } from "../../../../packages/contracts/src/config";
import {
  HttpPrometheusClient,
  MemoryPrometheusClient,
  PrometheusClient,
  PrometheusMetricBuffer,
  readRawChunks
} from "../../../../packages/metrics/src";
import { FakeRunOrchestrator } from "../../../../packages/compose-runner/src";
import { validateBenchmarkImageManifest } from "../../../../packages/contracts/src/openedge-validation";
import {
  loadOpenEdgeImageEnvironment,
  loadLocalEnvironment,
  requirePlatformEnvironment
} from "../../../../packages/contracts/src/local-env";
import {
  assertObserverOverheadPair,
  buildObserverOverheadEvidence
} from "../runs/observer-overhead";

class MirroredMetricBuffer extends PrometheusMetricBuffer {
  constructor(private readonly mirror: MemoryPrometheusClient) {
    super();
  }

  override append(samples: Parameters<PrometheusMetricBuffer["append"]>[0]): void {
    super.append(samples);
    this.mirror.append(samples);
  }
}

class SmokePrometheusClient implements PrometheusClient {
  private readonly remote: HttpPrometheusClient;

  constructor(
    baseUrl: string,
    private readonly localObserverMetrics: PrometheusMetricBuffer
  ) {
    this.remote = new HttpPrometheusClient(baseUrl);
  }

  waitForRunTargets(...args: Parameters<HttpPrometheusClient["waitForRunTargets"]>) {
    return this.remote.waitForRunTargets(...args);
  }

  health(): Promise<boolean> {
    return this.remote.health();
  }

  async queryInstant(query: string) {
    const [remote, local] = await Promise.all([
      this.remote.queryInstant(query),
      new MemoryPrometheusClient(this.localObserverMetrics.samples()).queryInstant(query)
    ]);
    return [...remote, ...local];
  }

  async queryRawRange(...args: Parameters<HttpPrometheusClient["queryRawRange"]>) {
    const [remote, local] = await Promise.all([
      this.remote.queryRawRange(...args),
      new MemoryPrometheusClient(this.localObserverMetrics.samples()).queryRawRange(...args)
    ]);
    return [...remote, ...local];
  }

  async queryRange(query: string, start: number, end: number, step: number) {
    const [remote, local] = await Promise.all([
      this.remote.queryRange(query, start, end, step),
      new MemoryPrometheusClient(this.localObserverMetrics.samples()).queryRange(
        query,
        start,
        end,
        step
      )
    ]);
    return [...remote, ...local];
  }
}

const args = parseArgs(process.argv.slice(2));
const localEnvironment = loadLocalEnvironment({ envFile: args.config });
if (args.openedge) {
  const localConfig = loadConfig();
  loadOpenEdgeImageEnvironment(
    localEnvironment.root,
    localConfig.openedge.outputRoot ?? path.resolve(localEnvironment.root, ".parkbench/openedge")
  );
  requirePlatformEnvironment(localEnvironment.root);
}
const fake = args.fake;
const config = loadConfig();
const smokeConfig = fake
  ? {
      ...config,
      dbPath: ":memory:",
      openedge: {
        ...config.openedge,
        dbImage: undefined,
        pasImage: undefined,
        defaultSeed: undefined,
        appArchive: undefined,
        credentialRef: undefined,
        imageManifestPath: undefined
      }
    }
  : {
      ...config,
      // A standalone live smoke can run beside the Compose control plane.
      // Keep its SQLite handle isolated; its target file shares the mounted
      // Prometheus directory but has a unique name so both controllers can run.
      dbPath: ":memory:"
    };
const scenarioFile =
  args.scenario ??
  (args.measureObserverOverhead
    ? "examples/scenarios/parkbench-bank-mix.json"
    : "examples/scenarios/crud-rest.json");
const scenario = validateScenario(JSON.parse(fs.readFileSync(scenarioFile, "utf8")));
const fakeOrchestrator = fake ? new FakeRunOrchestrator() : undefined;
const fakePrometheus = fake ? new MemoryPrometheusClient() : undefined;
const smokeObserverMetrics =
  fake && fakePrometheus
    ? new MirroredMetricBuffer(fakePrometheus)
    : args.openedge
      ? new PrometheusMetricBuffer()
      : undefined;
const smokePrometheus = fake
  ? fakePrometheus
  : args.openedge && smokeObserverMetrics
    ? new SmokePrometheusClient(config.prometheusUrl, smokeObserverMetrics)
    : undefined;
let smokeMetricsTarget: string;
const platform = createPlatform(
  smokeConfig,
  fake
    ? {
        testMode: true,
        prometheus: smokePrometheus,
        orchestrator: fakeOrchestrator,
        observerFactory: testObserverFactory(),
        observerMetrics: smokeObserverMetrics,
        supportImages: {
          loadgen: "parkbench/loadgen:fixture",
          observer: "parkbench/observer:fixture"
        },
        phaseScale: 0,
        requiredDiskIo: false
      }
    : {
        ...(smokePrometheus ? { prometheus: smokePrometheus } : {}),
        ...(smokeObserverMetrics ? { observerMetrics: smokeObserverMetrics } : {}),
        runCAdvisorTarget: () => smokeMetricsTarget,
        targetDiscoveryFileName: `standalone-smoke-${process.pid}-${Date.now()}.json`,
        ...(process.env.PARKBENCH_SMOKE_SKIP_DISK_IO === "1" ? { requiredDiskIo: false } : {})
      }
);
if (!platform.scenarios.get(scenario.id, scenario.version)) platform.scenarios.register(scenario);
const app = buildServer(platform);
const overheadVariants = [
  {
    id: "observer-off",
    name: "Database observer off",
    parameters: {
      "database.metricsEnabled": false,
      "workload.seed": scenario.workload.load.seed ?? 1
    }
  },
  {
    id: "observer-on",
    name: "Database observer on",
    parameters: {
      "database.metricsEnabled": true,
      "workload.seed": scenario.workload.load.seed ?? 1
    }
  }
];
const request = {
  scenario,
  comparisonMode: "comparative",
  baselineVariantId: args.measureObserverOverhead ? "observer-off" : "baseline",
  repetitions: 1,
  variants: args.measureObserverOverhead
    ? overheadVariants
    : [
        { id: "baseline", name: "Baseline", parameters: {} },
        { id: "variant", name: "Variant", parameters: { "-B": 10000 } }
      ],
  inputs: {
    databaseImage: (args.openedge ? config.openedge.dbImage : undefined) ?? "openedge-db:fixture",
    pasImage: (args.openedge ? config.openedge.pasImage : undefined) ?? "openedge-pas:fixture",
    ...seedInputs(),
    applicationArchive: (args.openedge ? config.openedge.appArchive : undefined) ?? "input:archive",
    credentialRef: args.openedge ? config.openedge.credentialRef : undefined
  }
} as any;
async function main() {
  try {
    if (args.measureObserverOverhead && !args.openedge)
      throw new Error("observer_overhead_requires_openedge_smoke");
    if (args.measureObserverOverhead && !(scenario.phases?.measurementSeconds >= 30))
      throw new Error("observer_overhead_requires_30_second_measurement");
    if (args.openedge) validateLiveManifest(config.openedge.imageManifestPath);
    await platform.startupRecovery;
    if (args.openedge) {
      const address = await app.listen({ host: "0.0.0.0", port: 0 });
      const port = new URL(address).port;
      const hostAddresses = Object.values(
        os.networkInterfaces() as Record<
          string,
          Array<{ family: string; internal: boolean; address: string }>
        >
      )
        .flat()
        .filter((address) => address?.family === "IPv4" && !address.internal)
        .map((address) => address!.address);
      const host =
        process.env.PARKBENCH_SMOKE_METRICS_HOST ??
        (hostAddresses.length === 1 ? hostAddresses[0] : "host.docker.internal");
      smokeMetricsTarget = `${host}:${port}`;
    }
    // Standalone smoke owns its isolated coordinator. Use its validated command
    // interface; the interactive HTTP API accepts reviewed disk-scenario matrices.
    request.variants.forEach(validateVariant);
    const created = platform.coordinator.createExperiment(request, scenario);
    const accepted = { experimentId: created.id, runCount: created.runIds.length };
    platform.coordinator.startExperiment(created.id);
    const experiment = await waitForTerminal(accepted.experimentId);
    const runsResponse: any = await app.inject({
      method: "GET",
      url: `/api/v1/experiments/${accepted.experimentId}/runs`
    });
    const runs = JSON.parse(runsResponse.body).runs ?? [];
    if (!runs.length || runs.some((run: any) => !TERMINAL_STATES.has(run.state))) {
      const states = runs.map((run: any) => `${run.id ?? "unknown"}:${run.state ?? "missing"}`);
      throw new Error(
        `smoke_run_not_terminal:experiment=${experiment.status}:expected=${accepted.runCount ?? "unknown"}:actual=${runs.length}:states=${states.join(",") || "none"}`
      );
    }
    for (const run of runs) {
      const { context, summary } = smokeArtifacts(run);
      if (args.openedge && !args.measureObserverOverhead && !nativeRuntimeByRun.has(run.id))
        throw (
          nativeRuntimeErrors.get(run.id) ?? new Error(`smoke_native_identity_missing:${run.id}`)
        );
      if (nativeRuntimeByRun.has(run.id)) run.nativeRuntime = nativeRuntimeByRun.get(run.id);
      run.validation = {
        contextPath: summary.contextReference.path,
        summaryPath: platform.repositories.getSummaryCache(run.id)!.artifactPath
      };
      if (run.cleanupStatus !== "COMPLETE") throw new Error(`smoke_cleanup_incomplete:${run.id}`);
      const eventsResponse: any = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${run.id}/events`
      });
      const events = JSON.parse(eventsResponse.body).events ?? [];
      for (const state of ["DB_READY", "PAS_READY"])
        if (!events.some((event: any) => event.toState === state))
          throw new Error(`smoke_readiness_missing:${run.id}:${state}`);
      if (summary.totalRowCount < 1) throw new Error(`smoke_application_metrics_missing:${run.id}`);
      if (args.openedge) {
        if (run.state !== "SUCCEEDED")
          throw new Error(`smoke_openedge_run_failed:${run.id}:${run.failureReason ?? run.state}`);
        const manifest = context.images.manifest as any;
        if (manifest?.imageStage !== "final" || manifest?.parkBenchReady !== true)
          throw new Error(`smoke_openedge_manifest_not_final:${run.id}`);
        const workload = summary.workload as any;
        if (
          !(Number(workload.requests?.completed) > 0) ||
          workload.requests?.errors !== 0 ||
          workload.timeoutCount !== 0
        )
          throw new Error(`smoke_openedge_workload_errors:${run.id}`);
        if (summary.quality.complete !== true)
          throw new Error(`smoke_openedge_observer_incomplete:${run.id}`);
        if (
          !summary.metricsReference.source ||
          !summary.windows.measurement.start ||
          !summary.windows.measurement.end
        )
          throw new Error(`smoke_openedge_metrics_reference_missing:${run.id}`);
        const resources = platform.repositories.listResources(run.id);
        if (
          !resources.length ||
          resources.some(
            (resource) =>
              resource.labels?.["parkbench.run_id"] !== run.id ||
              resource.cleanupResult !== "deleted"
          )
        )
          throw new Error(`smoke_openedge_cleanup_ownership_missing:${run.id}`);
        if (context.parameterReference?.state !== "captured")
          throw new Error(`smoke_openedge_parameter_snapshot_missing:${run.id}`);
        const parameterFile = `${run.id}/${context.parameterReference.artifact}`;
        if (!fs.existsSync(platform.storage.safePath(parameterFile)))
          throw new Error(`smoke_openedge_parameter_snapshot_artifact_missing:${run.id}`);
      }
    }
    const observerOverheadPath = args.measureObserverOverhead
      ? await persistObserverOverheadPair(runs)
      : undefined;
    if (fakeOrchestrator) {
      const readyIndex = fakeOrchestrator.calls.indexOf("ready");
      const exportIndex = fakeOrchestrator.calls.indexOf("collect-logs");
      const cleanupIndex = fakeOrchestrator.calls.indexOf("cleanup");
      if (readyIndex < 0 || cleanupIndex < 0 || (exportIndex >= 0 && exportIndex > cleanupIndex))
        throw new Error("smoke_terminal_order_invalid");
    }
    console.log(
      JSON.stringify(
        { ...experiment, runs, ...(observerOverheadPath ? { observerOverheadPath } : {}) },
        null,
        2
      )
    );
  } finally {
    await app.close();
  }
}

function smokeArtifacts(run: any) {
  const cache = platform.repositories.getSummaryCache(run.id);
  if (cache?.status !== "READY" || !cache.header || !cache.artifactPath)
    throw new Error(
      `smoke_summary_missing:${run.id}:${cache?.reason ?? cache?.status ?? "missing"}`
    );
  const summary = cache.header;
  validateSummaryHeader(summary, run.id);
  const context = JSON.parse(platform.storage.read(summary.contextReference.path).toString("utf8"));
  validateRunContext(context, run.id);
  return { context, summary };
}

async function persistObserverOverheadPair(runs: any[]): Promise<string> {
  if (runs.length !== 2) throw new Error("observer_overhead_pair_incomplete");
  const byVariant = new Map(runs.map((run) => [run.variantId, run]));
  const off = byVariant.get("observer-off");
  const on = byVariant.get("observer-on");
  if (!off || !on) throw new Error("observer_overhead_variants_invalid");
  const offArtifacts = smokeArtifacts(off),
    onArtifacts = smokeArtifacts(on);
  const pairInput = ({ context }: ReturnType<typeof smokeArtifacts>) => ({
    deterministicLoadSeed: Number(context.loadSeed),
    inputs: context.inputs,
    effectiveConfiguration: { values: context.effective.parameters as Record<string, unknown> }
  });
  assertObserverOverheadPair(pairInput(offArtifacts), pairInput(onArtifacts));
  const build = async (run: any, peer: any, mode: "observer_off" | "observer_on") => {
    const { context, summary } = smokeArtifacts(run);
    const samples: import("../../../../packages/contracts/src/metrics").MetricSample[] = [];
    const start = Date.parse(summary.windows.measurement.start!) / 1000;
    const end = Date.parse(summary.windows.measurement.end!) / 1000;
    // Observer resources are outside the database/PAS/platform accounting groups.
    // Read their original retained points rather than the grouped workload summary.
    for (const metric of [
      "parkbench_observer_collection_duration_seconds",
      "container_cpu_usage_seconds_total",
      "container_memory_working_set_bytes",
      "container_memory_usage_bytes"
    ]) {
      for await (const chunk of readRawChunks(
        platform.prometheus,
        `${metric}{run_id=${JSON.stringify(run.id)},phase="measurement"}`,
        start,
        end,
        summary.sampling.baseStepSeconds
      ))
        samples.push(...chunk.samples);
    }
    const workload = summary.workload as any;
    const evidence = buildObserverOverheadEvidence({
      mode,
      pairedRunId: peer.id,
      sharedLoadSeed: Number(context.loadSeed),
      samples,
      workload: {
        requests: Number(workload.requests.completed) + Number(workload.requests.errors),
        successes: Number(workload.requests.completed),
        failures: Number(workload.requests.errors),
        timeoutCount: workload.timeoutCount,
        timeoutMs: workload.timeoutMs,
        timeoutObservations: workload.timeoutObservations,
        throughputPerSecond:
          Number(workload.requests.completed) / summary.windows.measurement.durationSeconds,
        latencySeconds: workload.latencySeconds
      }
    });
    const durations = samples
      .filter(
        (sample) =>
          sample.metricName === "parkbench_observer_collection_duration_seconds" &&
          sample.labels.kind === "openedge_db_v1"
      )
      .map((sample) => sample.value);
    const maximumCollectionDurationSeconds = durations.length ? Math.max(...durations) : undefined;
    const parameterCaptureDurationSeconds = (context.observed.parameterSnapshotTelemetry as any)
      ?.captureDurationSeconds;
    if (
      mode === "observer_on" &&
      (!evidence.collectorDurationSeconds.samples ||
        evidence.observerResources.cpuCoreSeconds === undefined ||
        evidence.observerResources.peakMemoryBytes === undefined)
    )
      throw new Error(`observer_overhead_measurements_missing:${run.id}`);
    if (maximumCollectionDurationSeconds !== undefined && maximumCollectionDurationSeconds > 5)
      throw new Error(`observer_collection_budget_exceeded:${run.id}`);
    if (typeof parameterCaptureDurationSeconds !== "number" || parameterCaptureDurationSeconds > 10)
      throw new Error(`observer_capture_budget_unverified:${run.id}`);
    return {
      runId: run.id,
      validation: run.validation,
      ...evidence,
      durationScope: "metrics_endpoint_cached_response",
      maximumCollectionDurationSeconds,
      parameterCaptureDurationSeconds
    };
  };
  const evidence = {
    contractVersion: "observer-overhead-pair.v1",
    recordedAt: new Date().toISOString(),
    off: await build(off, on, "observer_off"),
    on: await build(on, off, "observer_on")
  };
  const relative = `observer-overhead/${off.id}-${on.id}.json`;
  platform.storage.write(relative, JSON.stringify(evidence, null, 2));
  return relative;
}

function validateLiveManifest(file: string | undefined): void {
  if (!file || !fs.existsSync(file)) throw new Error("final_openedge_manifest_required");
  validateBenchmarkImageManifest(JSON.parse(fs.readFileSync(file, "utf8")), true);
}

const nativeRuntimeByRun = new Map<string, Record<string, unknown>>();
const nativeRuntimeErrors = new Map<string, Error>();

const TERMINAL_STATES = new Set([
  "SUCCEEDED",
  "INCOMPLETE",
  "THRESHOLD_FAILED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
]);
const EXPERIMENT_TERMINAL_STATES = new Set([
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
]);

async function waitForTerminal(experimentId: string): Promise<any> {
  const phaseSeconds =
    scenario.phases.warmupSeconds +
    scenario.phases.measurementSeconds +
    scenario.phases.cooldownSeconds;
  // Both variants run serially; the standard 300-second measurement exceeds
  // the old ten-minute experiment timeout once provisioning/cleanup are included.
  const defaultTimeoutMs = Math.max(600_000, request.variants.length * (phaseSeconds + 180) * 1000);
  const timeout = Date.now() + Number(process.env.PARKBENCH_SMOKE_TIMEOUT_MS ?? defaultTimeoutMs);
  while (Date.now() < timeout) {
    const response: any = await app.inject({
      method: "GET",
      url: `/api/v1/experiments/${experimentId}`
    });
    const experiment = JSON.parse(response.body);
    if (args.openedge && !args.measureObserverOverhead) {
      for (const run of platform.repositories.listRuns(experimentId)) {
        if (
          nativeRuntimeByRun.has(run.id) ||
          nativeRuntimeErrors.has(run.id) ||
          !["WARMING_UP", "MEASURING", "COOLDOWN"].includes(run.state)
        )
          continue;
        // Record the runtime reported by the actual default collector, while its
        // owned container is connected. Image tags alone do not prove a patch.
        try {
          const raw = execFileSync(
            "docker",
            ["exec", `${run.composeProject}-db-observer-1`, config.openedge.dbObserverExecutable!],
            { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 }
          );
          const payload = JSON.parse(raw);
          if (payload.protocolVersion !== 4 || typeof payload.database?.productVersion !== "string")
            throw new Error(`smoke_native_identity_invalid:${run.id}`);
          const identity = {
            productVersion: payload.database.productVersion,
            protocolVersion: payload.protocolVersion,
            tables: payload.labels.tables.length,
            indexes: payload.labels.indexes.length
          };
          nativeRuntimeByRun.set(run.id, identity);
          platform.storage.write(
            `${run.id}/smoke-native-runtime.json`,
            JSON.stringify(identity, null, 2)
          );
        } catch (error) {
          // Finish orchestration and owned cleanup before reporting a failed probe.
          nativeRuntimeErrors.set(
            run.id,
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    }
    if (EXPERIMENT_TERMINAL_STATES.has(experiment.status)) return experiment;
    await new Promise((resolve) => setTimeout(resolve, fake ? 25 : 1000));
  }
  throw new Error("smoke_timeout_waiting_for_terminal");
}
const missingLicensedInputs =
  args.openedge &&
  (!config.openedge.dbImage ||
    !config.openedge.pasImage ||
    !config.openedge.defaultSeed ||
    !config.openedge.appArchive ||
    !config.openedge.dbObserverExecutable ||
    !config.openedge.imageManifestPath);

/** The configured default seed folder and the database it holds. */
function seedInputs(): Record<string, string> {
  if (!args.openedge || !config.openedge.defaultSeed) return { seed: "input:seed" };
  const seed = path.join(
    config.discoveryRoots?.seeds ?? path.resolve(".parkbench/seeds"),
    config.openedge.defaultSeed
  );
  const database = checkReadableSeedDirectory(seed);
  return {
    seed,
    seedName: database.name,
    databaseName: database.databaseName
  };
}

function parseArgs(argv: string[]): {
  fake: boolean;
  openedge: boolean;
  measureObserverOverhead: boolean;
  config?: string;
  scenario?: string;
} {
  const result: {
    fake: boolean;
    openedge: boolean;
    measureObserverOverhead: boolean;
    config?: string;
    scenario?: string;
  } = {
    fake: argv.includes("--fake"),
    openedge: argv.includes("--openedge"),
    measureObserverOverhead: argv.includes("--measure-observer-overhead")
  };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--config") result.config = argv[++index];
    if (argv[index] === "--scenario") result.scenario = argv[++index];
  }
  return result;
}

if (require.main === module) {
  if (missingLicensedInputs) {
    console.error("licensed OpenEdge smoke test requires local image, seed, and archive inputs");
    process.exitCode = 2;
  } else
    main().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
