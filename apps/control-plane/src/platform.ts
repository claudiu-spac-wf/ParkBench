import { ComparisonSummaryService } from "./runs/comparison-summary-service";
import { HistoricalSummaryWorker } from "./runs/historical-summary-worker";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ParkBenchConfig } from "../../../packages/contracts/src/config";
import { DatabaseClient } from "./db/client";
import { Repositories } from "./db/repositories";
import { ArtifactStorage } from "./artifacts/storage";
import { ArtifactService } from "./artifacts/service";
import {
  HttpPrometheusClient,
  MemoryPrometheusClient,
  PrometheusMetricBuffer,
  PrometheusClient
} from "../../../packages/metrics/src/prometheus-client";
import { Finalizer } from "./runs/finalizer";
import { RunCoordinator } from "./runs/coordinator";
import { ScenarioCatalog } from "./scenarios/catalog";
import {
  DockerComposeOrchestrator,
  FakeRunOrchestrator,
  RunOrchestrator,
  generateRunCompose
} from "../../../packages/compose-runner/src";
import {
  ObserverAdapter,
  ObserverDeclarationFactory,
  ObserverFactory,
  samplePath,
  sampleToMetrics,
  HttpMetricsObserver,
  commandDatabaseObserverV3,
  OpenEdgePasObserver,
  requestWithRetry,
  parsePrometheusText,
  ObserverRegistry,
  validateBuiltinObserverDeclaration
} from "../../../packages/observers/src";
import { FileDiscovery } from "../../../packages/metrics/src/discovery";
import { BootstrapService } from "./bootstrap/service";
import { StartupReconciler } from "./recovery/startup-reconciler";
import { saveDiagnostics } from "./artifacts/diagnostics";
import { ControlUiRepository } from "./storage/control-ui-repository";
import { ControlUiService } from "./control-ui/service";
import { verifyDiskIoSources } from "../../../packages/metrics/src/container-host";
import { DockerImageRunner } from "./image-operations/docker-image-runner";
import {
  CatalogDiscoveryService,
  DiscoveryProviders,
  fakeDiscoveryProviders
} from "./catalog/discovery-service";
import { DockerDiscoveryProvider } from "./catalog/docker-discovery";
import { ManagedRootFileDiscovery } from "./catalog/file-discovery";
import { CatalogBulkActions } from "./catalog/bulk-actions";
import { requirePlatformEnvironment } from "../../../packages/contracts/src/local-env";
import { RunMetricsAvailability } from "./runs/metrics-availability";
export interface Platform {
  config: ParkBenchConfig;
  inputRoot: string;
  database: DatabaseClient;
  repositories: Repositories;
  controlRepository: ControlUiRepository;
  controlUi: ControlUiService;
  discovery: CatalogDiscoveryService;
  catalogActions: CatalogBulkActions;
  discoveryReady: Promise<unknown>;
  storage: ArtifactStorage;
  artifacts: ArtifactService;
  prometheus: PrometheusClient;
  metricsAvailability: RunMetricsAvailability;
  orchestrator: RunOrchestrator;
  finalizer: Finalizer;
  summaryWorker?: HistoricalSummaryWorker;
  coordinator: RunCoordinator;
  scenarios: ScenarioCatalog;
  bootstrap: BootstrapService;
  requiredDiskIo: boolean;
  observerMetrics: PrometheusMetricBuffer;
  activeRunId: () => string | undefined;
  supportImages: SupportImages;
  requirePinnedSupportImages: boolean;
  supportsObserverKind: (kind: string) => boolean;
  validateObserverDeclaration: (declaration: any) => void;
  startupRecovery?: Promise<number>;
  close(): void;
}
export interface PlatformOptions {
  testMode?: boolean;
  inputRoot?: string;
  prometheus?: PrometheusClient;
  orchestrator?: RunOrchestrator;
  imageRunner?: import("./image-operations/image-operation-runner").ControlledImageRunner;
  observerFactory?: ObserverFactory;
  observerMetrics?: PrometheusMetricBuffer;
  observerExtensions?: ObserverExtension[];
  supportImages?: SupportImages;
  phaseScale?: number;
  requiredDiskIo?: boolean;
  targetDiscoveryFileName?: string;
  /** Reachable owner of the run-scoped cAdvisor proxy (standalone smoke). */
  runCAdvisorTarget?: () => string;
  discoveryProviders?: DiscoveryProviders;
  parameterCapture?: (
    run: import("../../../packages/contracts/src/run").Run,
    bundle: import("../../../packages/compose-runner/src/run-compose").ComposeBundle
  ) => Promise<
    import("../../../packages/contracts/src/openedge-db-parameter-capture").OpenEdgeDbParameterCapture
  >;
  requireParameterCapture?: boolean;
  summaryReader?: import("../../../packages/contracts/src/comparison").SummaryReader;
  summaryScheduler?: import("../../../packages/contracts/src/comparison").SummaryScheduler;
}

export function createTargetDiscovery(
  config: Pick<ParkBenchConfig, "artifactRoot" | "prometheusTargetDir">,
  testMode: boolean,
  fileName = "active-runs.json"
): FileDiscovery {
  if (!/^[a-z][a-z0-9-]*\.json$/.test(fileName))
    throw new Error("target_discovery_filename_invalid");
  const targetRoot = testMode
    ? path.join(config.artifactRoot, "prometheus-targets")
    : (config.prometheusTargetDir ?? path.resolve(".parkbench/prometheus-targets"));
  return new FileDiscovery(path.join(targetRoot, fileName));
}

export function createPlatform(config = loadConfig(), options: PlatformOptions = {}): Platform {
  const testMode = options.testMode === true;
  if (!testMode) requirePlatformEnvironment();
  const migrationCandidates = [
    path.join(__dirname, "db/migrations/001_foundation.sql"),
    path.join(process.cwd(), "apps/control-plane/src/db/migrations/001_foundation.sql")
  ];
  const migrationFiles = [
    ...migrationCandidates,
    path.join(__dirname, "db/migrations/003_control_ui.sql"),
    path.join(process.cwd(), "apps/control-plane/src/db/migrations/003_control_ui.sql"),
    path.join(__dirname, "db/migrations/004_catalog_discovery.sql"),
    path.join(process.cwd(), "apps/control-plane/src/db/migrations/004_catalog_discovery.sql"),
    path.join(__dirname, "db/migrations/005_run_failure_codes.sql"),
    path.join(process.cwd(), "apps/control-plane/src/db/migrations/005_run_failure_codes.sql"),
    path.join(__dirname, "db/migrations/006_catalog_actions.sql"),
    path.join(process.cwd(), "apps/control-plane/src/db/migrations/006_catalog_actions.sql"),
    path.join(__dirname, "db/migrations/007_run_comparison_summaries.sql"),
    path.join(
      process.cwd(),
      "apps/control-plane/src/db/migrations/007_run_comparison_summaries.sql"
    )
  ].filter((candidate, index, all) => fs.existsSync(candidate) && all.indexOf(candidate) === index);
  const migration = migrationFiles.length
    ? migrationFiles.map((candidate) => fs.readFileSync(candidate, "utf8")).join("\n")
    : "PRAGMA journal_mode = WAL;";
  const database = new DatabaseClient(config.dbPath);
  database.migrate(migration);
  const repositories = new Repositories(database);
  const storage = new ArtifactStorage(config.artifactRoot);
  const artifacts = new ArtifactService(storage, repositories);
  const managedInputRoot =
    options.inputRoot ?? process.env.PARKBENCH_CONTAINER_PATH_ROOT ?? process.cwd();
  const prometheus =
    options.prometheus ??
    (testMode ? new MemoryPrometheusClient() : new HttpPrometheusClient(config.prometheusUrl));
  const observerMetrics = options.observerMetrics ?? new PrometheusMetricBuffer();
  const supportImages = options.supportImages ?? {
    loadgen: process.env.PARKBENCH_LOADGEN_IMAGE ?? (testMode ? "parkbench/loadgen:fixture" : ""),
    observer:
      process.env.PARKBENCH_OBSERVER_IMAGE ??
      config.openedge.observerImage ??
      (testMode ? "parkbench/observer:fixture" : "")
  };
  const orchestrator =
    options.orchestrator ??
    (testMode
      ? new FakeRunOrchestrator()
      : new DockerComposeOrchestrator(
          config.runRoot ?? path.resolve(process.env.PARKBENCH_RUN_ROOT ?? ".parkbench/runs")
        ));
  const discoveryProviders =
    options.discoveryProviders ??
    (testMode
      ? {
          ...fakeDiscoveryProviders(),
          filesystem: new ManagedRootFileDiscovery(config.discoveryRoots ?? {})
        }
      : {
          docker: new DockerDiscoveryProvider({
            listLocalImages: async () => {
              if (!orchestrator.listLocalImages) throw new Error("docker_discovery_unavailable");
              return orchestrator.listLocalImages();
            },
            inspectImageDetails: (image) => orchestrator.inspectImageDetails?.(image)
          }),
          filesystem: new ManagedRootFileDiscovery(config.discoveryRoots ?? {})
        });
  const comparisonSummaries = new ComparisonSummaryService(
    repositories,
    storage,
    prometheus,
    config.prometheusScrapeIntervalSeconds
  );
  const metricsAvailability = new RunMetricsAvailability(
    repositories,
    prometheus,
    config.prometheusRetention
  );
  const summaryWorker = new HistoricalSummaryWorker(repositories, comparisonSummaries);
  const finalizer = new Finalizer(
    repositories,
    storage,
    prometheus,
    config.prometheusScrapeIntervalSeconds,
    comparisonSummaries
  );
  const scenarios = new ScenarioCatalog();
  const observerFactory =
    options.observerFactory ??
    (testMode
      ? testObserverFactoryWithExtensions(options.observerExtensions ?? [])
      : registryObserverFactory(options.observerExtensions ?? []));
  const validateObserver = (declaration: any): void => {
    const candidate = hydrateObserverDeclaration(declaration, config, testMode);
    validateBuiltinObserverDeclaration(candidate, { allowTestHttpFallback: testMode });
    observerFactory.validate?.(candidate);
    const adapter = observerFactory.create(candidate, {
      runId: "observer-validation",
      experimentId: "observer-validation",
      variantId: "observer-validation",
      repetition: 1,
      phase: "measurement"
    });
    if (!adapter || typeof adapter.ready !== "function" || typeof adapter.sample !== "function")
      throw new Error(`observer_lifecycle_invalid:${declaration.id}`);
  };
  const requiredDiskIo = options.requiredDiskIo ?? !testMode;
  const targetDiscovery = createTargetDiscovery(
    config,
    testMode,
    options.targetDiscoveryFileName ?? "active-runs.json"
  );
  if (!testMode) targetDiscovery.clear();
  const coordinator = new RunCoordinator(
    repositories,
    finalizer,
    artifacts,
    prometheus,
    new Map(),
    {
      orchestrator,
      observerFactory,
      testMode,
      observerMetrics,
      observerSamplingIntervalSeconds: config.prometheusScrapeIntervalSeconds,
      cadvisorHousekeepingSeconds: config.cadvisorHousekeepingSeconds,
      inputRoot: managedInputRoot,
      workloadsRoot: config.discoveryRoots?.workloads,
      seedsRoot: config.discoveryRoots?.seeds,
      runRoot: testMode ? undefined : config.runRoot,
      supportImages,
      observerSupports: (kind) => observerFactory.supports?.(kind) ?? true,
      observerValidate: validateObserver,
      openedge: config.openedge,
      parameterCapture: options.parameterCapture,
      requireParameterCapture: options.requireParameterCapture ?? !testMode,
      requirePinnedSupportImages: !testMode,
      phaseScale: options.phaseScale ?? (testMode ? 0 : 1),
      requiredDiskIo,
      targetDiscovery,
      runCAdvisorTarget: options.runCAdvisorTarget
    }
  );
  const bootstrap = new BootstrapService(
    undefined,
    repositories,
    orchestrator,
    artifacts,
    supportImages,
    config.openedge
  );
  const controlRepository = new ControlUiRepository(database);
  const controlUi = new ControlUiService({
    prometheusUrl: config.prometheusUrl,
    summaryReader: options.summaryReader,
    summaryScheduler: options.summaryScheduler ?? summaryWorker,
    repositories,
    controlRepository,
    scenarios,
    coordinator,
    testMode,
    grafanaUrl: config.grafanaUrl,
    coordinatorHealth: () => orchestrator.health?.(),
    prometheusHealth: () => prometheus.health(),
    inspectImage: (image) => orchestrator.inspectImage?.(image) ?? Promise.resolve(false),
    diskIoSources: () => verifyDiskIoSources(prometheus, config.cadvisorUrl),
    observerValidate: validateObserver,
    inputRoot: managedInputRoot,
    discoveryRoots: {
      scenarios: config.discoveryRoots?.scenarios,
      workloads: config.discoveryRoots?.workloads,
      observers: config.discoveryRoots?.observers,
      seeds: config.discoveryRoots?.seeds,
      archives: config.discoveryRoots?.archives
    },
    inputRefs: {
      databaseImage: config.openedge.dbImage,
      pasImage: config.openedge.pasImage,
      credentialRef: config.openedge.credentialRef,
      seed: config.openedge.defaultSeed ? `input:seeds/${config.openedge.defaultSeed}` : undefined,
      applicationArchive: config.openedge.appArchive
    },
    databaseCapabilities: {
      version: config.openedge.version,
      features: config.openedge.databaseFeatures
    },
    supportImages,
    grafanaAvailability: () =>
      process.env.PARKBENCH_GRAFANA_UNAVAILABLE === "1"
        ? "unavailable"
        : process.env.PARKBENCH_GRAFANA_DEGRADED === "1"
          ? "degraded"
          : "available",
    dashboardProbe: async (context) => {
      if (testMode)
        return {
          grafana: true,
          prometheus: true,
          labelsValid: context.runIds.length > 0,
          metricsAvailability: await metricsAvailability.forRuns(context.runIds)
        };
      if (process.env.PARKBENCH_GRAFANA_UNAVAILABLE === "1")
        return { grafana: false, prometheus: false, labelsValid: false };
      const [grafana, prometheusHealthy] = await Promise.all([
        fetch(`${config.grafanaHealthUrl ?? config.grafanaUrl}/api/health`, {
          signal: AbortSignal.timeout(3000)
        })
          .then((response) => response.ok)
          .catch(() => false),
        prometheus.health()
      ]);
      let labelsValid = true;
      let availability;
      if (context.runIds.length) {
        try {
          availability = await metricsAvailability.forRuns(context.runIds);
          labelsValid = !Object.values(availability).includes("unavailable");
        } catch {
          labelsValid = false;
        }
      }
      return {
        grafana,
        prometheus: prometheusHealthy,
        labelsValid,
        metricsAvailability: availability
      };
    },
    imageRunner:
      options.imageRunner ??
      new DockerImageRunner(
        (image) => orchestrator.inspectImage?.(image) ?? Promise.resolve(false),
        { testMode, managedRoot: managedInputRoot }
      )
  });
  const discovery = new CatalogDiscoveryService(controlRepository, discoveryProviders);
  const catalogActions = new CatalogBulkActions(
    controlRepository,
    config.discoveryRoots ?? {},
    testMode ? undefined : config.openedge.pasImage,
    config.openedge.dbImage,
    { version: config.openedge.version, features: config.openedge.databaseFeatures }
  );
  const discoveryReady = discovery.refresh();
  const reconciler = new StartupReconciler(
    repositories,
    finalizer,
    async (run, stage) => {
      const snapshot = (run.environmentSnapshot ?? {}) as any;
      const scenario = snapshot.scenario as any;
      const inputs = snapshot.inputs ?? {};
      if (!scenario) throw new Error("cleanup_context_missing");
      const bundle = generateRunCompose(
        run.id,
        run.experimentId,
        scenario,
        { db: inputs.databaseImage, pas: inputs.pasImage },
        {
          ...inputs,
          parameters: snapshot.effectiveConfiguration ?? {},
          loadgenImage: supportImages.loadgen,
          observerImage: supportImages.observer,
          dbObserverImage: config.openedge.observerImage,
          summaryPath: path.join(config.artifactRoot, run.id, "loadgen-summary.json"),
          shutdownPath: path.join(config.artifactRoot, run.id, "shutdown")
        }
      );
      if (stage === "beforeMetrics") {
        try {
          await orchestrator.stopWorkload(bundle);
        } catch (error) {
          saveDiagnostics(storage, repositories, run.id, {
            code: "recovery_workload_stop_failed",
            error: String(error)
          });
        }
        return;
      }
      const resources = repositories.listResources(run.id) as any;
      targetDiscovery.remove(run.id);
      const cleaned = await orchestrator.cleanup(bundle, resources);
      cleaned.forEach((resource) => repositories.saveResource(run.id, resource));
      if (cleaned.some((resource) => resource.cleanupResult !== "deleted"))
        throw new Error("owned_resource_cleanup_incomplete");
    },
    () => bootstrap.retryPendingCleanup()
  );
  const startupRecovery = reconciler.run().then((count) => {
    summaryWorker.recover();
    return count;
  });
  return {
    config,
    metricsAvailability,
    inputRoot: managedInputRoot,
    database,
    repositories,
    controlRepository,
    controlUi,
    discovery,
    catalogActions,
    discoveryReady,
    storage,
    artifacts,
    prometheus,
    orchestrator,
    finalizer,
    coordinator,
    scenarios,
    bootstrap,
    requiredDiskIo,
    observerMetrics,
    activeRunId: () => targetDiscovery.activeRunId(),
    supportImages,
    requirePinnedSupportImages: !testMode,
    supportsObserverKind: (kind) => observerFactory.supports?.(kind) ?? true,
    validateObserverDeclaration: validateObserver,
    startupRecovery,
    summaryWorker,
    close: () => {
      controlUi.close();
      summaryWorker.stop();
      database.close();
    }
  };
}

function hydrateObserverDeclaration(
  declaration: any,
  config: ParkBenchConfig,
  testMode: boolean
): any {
  if (testMode || declaration?.kind !== "openedge_db_v1") return declaration;
  const openedge = config.openedge;
  if (!openedge.dbObserverExecutable && !openedge.dbObserverProcedure) return declaration;
  return {
    ...declaration,
    configuration: {
      ...(declaration.configuration ?? {}),
      observerExecutable:
        openedge.dbObserverExecutable ?? declaration.configuration?.observerExecutable,
      observerProcedure:
        openedge.dbObserverProcedure ??
        declaration.configuration?.observerProcedure ??
        "/app/openedge/observers/db/prepare-run-db-observer.p"
    }
  };
}

const httpObserverFactory: ObserverFactory = {
  create(declaration) {
    const configuration = declaration.configuration ?? {};
    if (
      declaration.kind === "openedge_db_v1" &&
      typeof configuration.observerExecutable === "string" &&
      typeof configuration.observerProcedure === "string"
    )
      return nativeDatabaseObserver(declaration, undefined);
    if (declaration.kind === "openedge_db_v1" && typeof configuration.metricsUrl !== "string")
      throw new Error(`observer_native_command_required:${declaration.id}`);
    if (declaration.kind === "openedge_pas_v1" && typeof configuration.metricsUrl === "string")
      return nativePasObserver(
        declaration,
        configuration.metricsUrl,
        Number(configuration.replicas ?? 1),
        typeof configuration.credentialRef === "string"
          ? configuration.credentialRef
          : process.env.PARKBENCH_CREDENTIAL_REF
      );
    if (typeof configuration.metricsUrl === "string")
      return new HttpMetricsObserver(
        declaration.id,
        declaration.kind,
        configuration.metricsUrl,
        typeof configuration.metricsPath === "string" ? configuration.metricsPath : "/metrics",
        typeof configuration.timeoutMs === "number" ? configuration.timeoutMs : 3000
      );
    if (declaration.kind === "file_sampler_v1" && typeof configuration.path === "string")
      return fileObserver(declaration, configuration.path);
    return undefined;
  }
};

export interface SupportImages {
  loadgen: string;
  observer: string;
}

export interface ObserverExtension {
  kind: string;
  factory: ObserverDeclarationFactory;
  validate?: (declaration: any) => void;
}

function registryObserverFactory(extensions: ObserverExtension[] = []): ObserverFactory {
  const builtins: Record<
    string,
    { factory: ObserverDeclarationFactory; validate: (declaration: any) => void }
  > = {
    core: {
      factory: (declaration, context) => httpObserverFactory.create(declaration, context),
      validate: validateBuiltinObserverDeclaration
    },
    openedge_db_v1: {
      factory: (declaration, context) => httpObserverFactory.create(declaration, context),
      validate: validateBuiltinObserverDeclaration
    },
    openedge_pas_v1: {
      factory: (declaration, context) => httpObserverFactory.create(declaration, context),
      validate: validateBuiltinObserverDeclaration
    },
    file_sampler_v1: {
      factory: (declaration, context) => httpObserverFactory.create(declaration, context),
      validate: validateBuiltinObserverDeclaration
    }
  };
  const registry = new ObserverRegistry([
    ...Object.entries(builtins).map(([kind, definition]) => ({
      kind,
      factory: definition.factory,
      validate: definition.validate
    })),
    ...extensions
  ]);
  return {
    create(declaration, context) {
      return registry.createDeclaration(declaration, context);
    },
    supports(kind) {
      return registry.supports(kind);
    },
    validate(declaration) {
      registry.validateDeclaration(declaration);
    }
  };
}

function nativeDatabaseObserver(declaration: any, _metricsUrl?: string): ObserverAdapter {
  const executable = declaration.configuration?.observerExecutable;
  const procedure = declaration.configuration?.observerProcedure;
  if (typeof executable === "string" && typeof procedure === "string")
    return commandDatabaseObserverV3({
      executable,
      procedure,
      timeoutMs: Number(declaration.configuration?.timeoutMs ?? 5000),
      args: Array.isArray(declaration.configuration?.observerArgs)
        ? declaration.configuration.observerArgs.filter(
            (value: unknown) => typeof value === "string"
          )
        : undefined
    });
  throw new Error(`observer_native_command_required:${declaration.id}`);
}

function nativePasObserver(
  declaration: any,
  metricsUrl: string,
  replicaCount: number,
  credentialRef?: string
): ObserverAdapter {
  return new OpenEdgePasObserver(
    async (replica, context) => {
      const response = await requestWithRetry(
        `${metricsUrl}/metrics?replica=${replica}`,
        Number(declaration.configuration?.timeoutMs ?? 3000),
        credentialRef
      );
      if (!response.ok) throw new Error(`openedge_pas_metrics_failed:${response.status}`);
      const samples = parsePrometheusText(await response.text(), context!, declaration.id);
      return samples;
    },
    Array.from({ length: Math.max(1, replicaCount) }, (_, index) => index + 1),
    () => pasObserverHealth(declaration, metricsUrl, replicaCount, credentialRef)
  );
}

async function pasObserverHealth(
  declaration: any,
  metricsUrl: string,
  replicaCount: number,
  credentialRef?: string
): Promise<boolean> {
  if (!(await observerHealth(metricsUrl, credentialRef)))
    throw new Error("pas_observer_health_unready");
  try {
    await Promise.all(
      Array.from({ length: Math.max(1, replicaCount) }, async (_, index) => {
        const replica = index + 1;
        const response = await requestWithRetry(
          `${metricsUrl}/metrics?replica=${replica}`,
          Number(declaration.configuration?.timeoutMs ?? 3000),
          credentialRef
        );
        if (!response.ok) throw new Error(`pas_observer_metrics_failed:${response.status}`);
        const samples = parsePrometheusText(
          await response.text(),
          {
            runId: "observer-readiness",
            experimentId: "observer-readiness",
            variantId: "observer-readiness",
            repetition: 1,
            phase: "measurement"
          },
          declaration.id
        );
        if (!samples.some((sample) => sample.metricName.startsWith("parkbench_openedge_pas_")))
          throw new Error("pas_observer_metrics_missing");
      })
    );
    return true;
  } catch (error) {
    if (String(error).startsWith("Error: pas_observer_")) throw error;
    throw new Error("pas_observer_probe_failed");
  }
}

async function observerHealth(url: string, credentialRef?: string): Promise<boolean> {
  try {
    const response = await requestWithRetry(`${url}/health`, 3000, credentialRef);
    return response.ok;
  } catch {
    return false;
  }
}

function fileObserver(declaration: any, filePath: string): ObserverAdapter {
  return {
    id: declaration.id,
    kind: declaration.kind,
    async ready() {
      return true;
    },
    async sample(context) {
      return sampleToMetrics(samplePath(filePath), context);
    }
  };
}

export function testObserverFactory(): ObserverFactory {
  const samplesByKind: Record<string, string[]> = {
    core: ["parkbench_workload_requests_total", "parkbench_container_health"],
    openedge_db_v1: ["parkbench_openedge_db_buffer_pool_logical_reads_total"],
    openedge_pas_v1: ["parkbench_openedge_pas_requests_total"],
    file_sampler_v1: ["parkbench_file_size_bytes"]
  };
  return {
    create(declaration) {
      return {
        id: declaration.id,
        kind: declaration.kind,
        async ready() {
          return true;
        },
        async latchInventory(context) {
          if (declaration.kind !== "openedge_db_v1") throw new Error("fixture_not_native");
          return {
            runId: context.runId,
            database: "fixture-only",
            databaseEpoch: "fixture-epoch",
            capturedAt: new Date().toISOString(),
            authoritativePublisher: "endpoint" as const,
            complete: true as const,
            instances: [
              {
                latch_name: "fixture-only",
                latch_type: "fixture-only",
                latch_id: "fixture-only",
                availability: "available" as const
              }
            ]
          };
        },
        async sample(context) {
          const timestamp = Date.now() / 1000;
          const basic = (samplesByKind[declaration.kind] ?? []).map((metricName) => ({
            metricName,
            labels: {
              experiment_id: context.experimentId,
              run_id: context.runId,
              variant_id: context.variantId,
              repetition: String(context.repetition),
              component: "observer",
              service: declaration.id,
              phase: context.phase as any
            },
            timestamp,
            value: 1,
            source: `fake:${declaration.kind}`
          }));
          if (declaration.kind !== "openedge_db_v1") return basic;
          const labels = {
            ...basic[0].labels,
            job: "parkbench-runs",
            service: "database",
            database: "fixture-only",
            database_epoch: "fixture-epoch"
          };
          const tuple = {
            latch_name: "fixture-only",
            latch_type: "fixture-only",
            latch_id: "fixture-only"
          };
          return [
            ...basic,
            ...["latch_inventory_complete", "latch_inventory_instances"].map((name) => ({
              metricName: `parkbench_openedge_db_${name}`,
              type: "gauge" as const,
              labels,
              timestamp,
              value: 1,
              source: "fake:openedge_db_v4"
            })),
            {
              metricName: "parkbench_openedge_db_latch_inventory_info",
              type: "gauge" as const,
              labels: { ...labels, ...tuple },
              timestamp,
              value: 1,
              source: "fake:openedge_db_v4"
            },
            {
              metricName: "parkbench_openedge_db_latch_named_waits_total",
              type: "counter" as const,
              labels: { ...labels, ...tuple },
              timestamp,
              value: 0,
              source: "fake:openedge_db_v4"
            },
            ...["latch_named_waits_total", "latch_named_wait_or_spin_duration_seconds_total"].map(
              (measurement) => ({
                metricName: "parkbench_openedge_db_metric_available",
                type: "gauge" as const,
                labels: {
                  ...labels,
                  ...tuple,
                  family: "latch",
                  measurement,
                  reason: measurement.endsWith("waits_total") ? "available" : "field_missing"
                },
                timestamp,
                value: measurement.endsWith("waits_total") ? 1 : 0,
                source: "fake:openedge_db_v4"
              })
            )
          ];
        }
      };
    }
  };
}

function testObserverFactoryWithExtensions(extensions: ObserverExtension[]): ObserverFactory {
  const fallback = testObserverFactory();
  const builtinKinds = new Set(["core", "openedge_db_v1", "openedge_pas_v1", "file_sampler_v1"]);
  return {
    create(declaration, context) {
      const extension = extensions.find((candidate) => candidate.kind === declaration.kind);
      return (
        extension?.factory(declaration, context) ??
        (builtinKinds.has(declaration.kind) ? fallback.create(declaration, context) : undefined)
      );
    },
    supports(kind) {
      return builtinKinds.has(kind) || extensions.some((extension) => extension.kind === kind);
    },
    validate(declaration) {
      extensions.find((candidate) => candidate.kind === declaration.kind)?.validate?.(declaration);
    }
  };
}
