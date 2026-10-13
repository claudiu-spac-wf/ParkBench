import fs from "node:fs";
import { loadConfig } from "../../../../packages/contracts/src/config";
import { validateScenario } from "../../../../packages/contracts/src/validator";
import { validateExperimentRequest } from "../../../../packages/compose-runner/src/preflight";
import { DockerComposeOrchestrator } from "../../../../packages/compose-runner/src/orchestrator";
import { HttpPrometheusClient, verifyDiskIoSources } from "../../../../packages/metrics/src";
import { hostCapacity } from "../preflight/capacity";
import { checkImageReference } from "../../../../packages/compose-runner/src/input-checks";
import path from "node:path";
import {
  checkReadableFile,
  checkReadableSeedDirectory,
  checkRunRootSpace
} from "../../../../packages/compose-runner/src/input-checks";
import {
  OBSERVER_CONTRACT_VERSIONS,
  validateBuiltinObserverDeclaration
} from "../../../../packages/observers/src";
import {
  validateBenchmarkImageManifest,
  validateWorkScenario,
  workProcedureNames
} from "../../../../packages/contracts/src/openedge-validation";
import {
  checkContractAgainstSeed,
  validateWorkloadContract
} from "../../../../packages/contracts/src/workload-contract";
import {
  loadLocalEnvironment,
  requirePlatformEnvironment
} from "../../../../packages/contracts/src/local-env";
const configIndex = process.argv.indexOf("--config");
const configFile = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
if (configFile) loadLocalEnvironment({ envFile: configFile });
else loadLocalEnvironment();
if (!process.argv.includes("--help")) requirePlatformEnvironment();
const config = loadConfig();
const scenarioIndex = process.argv.indexOf("--scenario");
const file =
  scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : "examples/scenarios/crud-rest.json";
async function main(): Promise<void> {
  if (!fs.existsSync(file)) throw new Error(`scenario_missing:${file}`);
  const scenario = validateScenario(JSON.parse(fs.readFileSync(file, "utf8")));
  validateWorkScenario(scenario);
  const seedsRoot = config.discoveryRoots?.seeds ?? path.resolve(".parkbench/seeds");
  const inputs = {
    databaseImage: config.openedge.dbImage ?? "",
    pasImage: config.openedge.pasImage ?? "",
    seed: config.openedge.defaultSeed ? path.join(seedsRoot, config.openedge.defaultSeed) : "",
    applicationArchive: config.openedge.appArchive ?? "",
    credentialRef: config.openedge.credentialRef
  };
  let imageManifest: any;
  if (config.openedge.imageManifestPath) {
    if (!fs.existsSync(config.openedge.imageManifestPath))
      throw new Error("openedge_image_manifest_missing");
    imageManifest = validateBenchmarkImageManifest(
      JSON.parse(fs.readFileSync(config.openedge.imageManifestPath, "utf8")),
      true
    );
    if (imageManifest.db.reference !== inputs.databaseImage)
      throw new Error("openedge_manifest_database_image_mismatch");
    if (imageManifest.pasoe.reference !== inputs.pasImage)
      throw new Error("openedge_manifest_pasoe_image_mismatch");
    if (workProcedureNames(scenario).length) {
      if (!inputs.seed || !inputs.applicationArchive || inputs.applicationArchive.startsWith("input:"))
        throw new Error("seed_path_required");
      validateWorkScenario(scenario, imageManifest);
      const seed = checkReadableSeedDirectory(inputs.seed);
      checkReadableFile(inputs.applicationArchive, "application_archive");
      const workloadsRoot = path.resolve(config.discoveryRoots?.workloads ?? "openedge/workloads/Workloads");
      for (const procName of workProcedureNames(scenario)) {
        const workload = imageManifest.workloads.find((candidate: any) => candidate.procName === procName);
        const contractFile = path.join(workloadsRoot, workload.contract.path.replace(/^Workloads\//, ""));
        if (!fs.existsSync(contractFile)) throw new Error(`workload_contract_missing:${procName}`);
        checkContractAgainstSeed(
          validateWorkloadContract(JSON.parse(fs.readFileSync(contractFile, "utf8")), procName),
          seed
        );
      }
      checkRunRootSpace(seed, config.runRoot ?? process.cwd());
    }
  }
  const supportImages = {
    loadgen: process.env.PARKBENCH_LOADGEN_IMAGE ?? "",
    observer: process.env.PARKBENCH_OBSERVER_IMAGE ?? config.openedge.observerImage ?? ""
  };
  if (
    imageManifest &&
    config.openedge.observerImage &&
    imageManifest.observer.reference !== config.openedge.observerImage
  )
    throw new Error("observer_image_mismatch");
  checkImageReference(supportImages.loadgen);
  checkImageReference(supportImages.observer);
  scenario.observers.forEach((observer) => {
    if (!(observer.kind in OBSERVER_CONTRACT_VERSIONS))
      throw new Error(`observer_adapter_unavailable:${observer.kind}`);
    validateBuiltinObserverDeclaration(withConfiguredDatabaseObserver(observer));
  });
  const capacity = hostCapacity();
  const prometheus = new HttpPrometheusClient(config.prometheusUrl);
  if (!(await prometheus.health())) throw new Error("prometheus_unavailable");
  const diskIo = await verifyDiskIoSources(prometheus, config.cadvisorUrl);
  const docker = new DockerComposeOrchestrator();
  if (!(await docker.health?.())) throw new Error("docker_unavailable");
  const [
    dbImageInspectable,
    pasImageInspectable,
    loadgenImageInspectable,
    observerImageInspectable
  ] = await Promise.all([
    docker.inspectImage?.(inputs.databaseImage),
    docker.inspectImage?.(inputs.pasImage),
    docker.inspectImage?.(supportImages.loadgen),
    docker.inspectImage?.(supportImages.observer)
  ]);
  if (
    !dbImageInspectable ||
    !pasImageInspectable ||
    !loadgenImageInspectable ||
    !observerImageInspectable
  )
    throw new Error("image_not_inspectable");
  const result = validateExperimentRequest(
    {
      scenario: { id: scenario.id, version: scenario.version },
      comparisonMode: "exploratory",
      repetitions: 1,
      variants: [{ id: "preflight", name: "Preflight", parameters: {} }],
      inputs
    },
    scenario,
    {
      diskIo,
      dockerAvailable: true,
      prometheusAvailable: true,
      hostCpu: capacity.cpu,
      freeBytes: capacity.freeBytes,
      seedsRoot,
      observerValidate: (observer) =>
        validateBuiltinObserverDeclaration(withConfiguredDatabaseObserver(observer))
    }
  );
  console.log(
    JSON.stringify(
      {
        valid: true,
        scenario: `${scenario.id}@${scenario.version}`,
        host: config.host,
        capacity,
        diskIo,
        inputs: result.provenance,
        imageManifest: imageManifest
          ? {
              path: config.openedge.imageManifestPath,
              imageStage: imageManifest.imageStage,
              parkBenchReady: imageManifest.parkBenchReady,
              buildDurationMs: imageManifest.buildDurationMs,
              totalBuildDurationMs: imageManifest.totalBuildDurationMs
            }
          : undefined,
        openedgeInputsConfigured: true
      },
      null,
      2
    )
  );
}

function withConfiguredDatabaseObserver(observer: any): any {
  if (observer.kind !== "openedge_db_v1") return observer;
  const configured = config.openedge;
  if (!configured.dbObserverExecutable && !configured.dbObserverProcedure) return observer;
  return {
    ...observer,
    configuration: {
      ...(observer.configuration ?? {}),
      observerExecutable:
        configured.dbObserverExecutable ?? observer.configuration?.observerExecutable,
      observerProcedure:
        configured.dbObserverProcedure ??
        observer.configuration?.observerProcedure ??
        "/app/openedge/observers/db/prepare-run-db-observer.p"
    }
  };
}

if (require.main === module)
  main().catch((error) => {
    console.error(JSON.stringify({ valid: false, error: String(error) }, null, 2));
    process.exitCode = 1;
  });
