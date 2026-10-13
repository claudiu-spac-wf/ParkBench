import { resolveFreshStartupFiles } from "./input-checks";
import { canonicalParameterValues } from "../../contracts/src/matrix-expansion";
import { validateScenarioParameterValues } from "../../contracts/src/scenario-parameter-validation";
import {
  databaseParameterOptions,
  databaseParameterInput,
  validateDatabaseParameterConfiguration,
  validateDatabaseParameterPaths
} from "../../contracts/src/database-parameter-options";
import { validateLegacyDatabaseParameterValue } from "../../contracts/src/database-parameter-options-v1";
import {
  DatabaseRunControlCapabilities,
  resolveDatabaseRunControls,
  validateWriterCapacity
} from "../../contracts/src/database-run-controls";
import { Scenario } from "../../contracts/src/scenario";
import { ExperimentRequest } from "../../contracts/src/experiment";
import { validateScenario } from "../../contracts/src/validator";
import { validateVariant } from "../../contracts/src/variant";
import { requireDiskIoSources } from "../../metrics/src/container-host";
import {
  checkCredentialReference,
  checkImageReference,
  checkInputReference,
  InputProvenance
} from "./input-checks";
export interface PreflightEnvironment {
  scenario: Scenario;
  inputs: Record<string, unknown>;
  provenance: InputProvenance[];
  warnings: string[];
}
export interface PreflightOptions {
  /** Internal queued-run validation: startup was frozen by a controller preview. Never set for new API requests. */
  frozenDatabaseStartup?: boolean;
  databaseCapabilities?: DatabaseRunControlCapabilities;
  diskIo?: { cadvisor: boolean; nodeExporterBlockDevice: boolean };
  hostCpu?: number;
  freeBytes?: number;
  inputRoot?: string;
  /** Seeds may also sit under the configured seeds root. */
  seedsRoot?: string;
  dockerAvailable?: boolean;
  prometheusAvailable?: boolean;
  imageInspectable?: boolean;
  observerValidate?: (declaration: Scenario["observers"][number]) => void;
}
export function validateExperimentRequest(
  request: ExperimentRequest,
  scenario: unknown,
  options: PreflightOptions = {}
): PreflightEnvironment {
  const parsed = validateScenario(scenario);
  parsed.observers.forEach((observer) => options.observerValidate?.(observer));
  if (parsed.id !== request.scenario.id || parsed.version !== request.scenario.version)
    throw new Error("scenario_reference_mismatch");
  if (!Number.isInteger(request.repetitions) || request.repetitions < 1)
    throw new Error("repetitions_must_be_positive");
  if (!request.variants.length) throw new Error("at_least_one_variant_required");
  const ids = new Set<string>();
  for (const providedVariant of request.variants) {
    const variant =
      providedVariant.databaseStartup && !providedVariant.databaseStartup.registryVersion
        ? providedVariant
        : { ...providedVariant, parameters: canonicalParameterValues(providedVariant.parameters) };
    if (ids.has(variant.id)) throw new Error(`duplicate_variant:${variant.id}`);
    ids.add(variant.id);
    const legacy = !!variant.databaseStartup && !variant.databaseStartup.registryVersion;
    if (legacy) {
      for (const [name, value] of Object.entries(variant.parameters)) {
        if (name.startsWith("-")) validateLegacyDatabaseParameterValue(name, value);
        else validateVariant({ ...variant, parameters: { [name]: value } });
      }
    } else validateVariant(variant);
    const defaults = Object.fromEntries(
      (parsed.parameterDefinitions ?? [])
        .filter((d) => d.defaultValue !== undefined)
        .map((d) => [d.canonicalName, d.defaultValue])
    );
    if (!legacy) {
      const startup = options.frozenDatabaseStartup
        ? variant.databaseStartup
        : resolveFreshStartupFiles(
            request.inputs.seed,
            defaults,
            variant.parameters,
            variant.databaseStartup
          );
      const effective = {
        ...defaults,
        ...variant.parameters,
        ...Object.fromEntries(
          (startup?.parameters ?? []).map((p) => [
            p.name,
            databaseParameterInput(p.name, p.displayValue)
          ])
        )
      };
      validateScenarioParameterValues(
        parsed.parameterDefinitions ?? [],
        effective,
        options.databaseCapabilities ?? {}
      );
      validateDatabaseParameterConfiguration(
        effective,
        databaseParameterOptions(options.databaseCapabilities)
      );
      validateDatabaseParameterPaths(effective, startup?.databaseName ?? "parkbench");
    }
    const controls = resolveDatabaseRunControls(
      defaults,
      variant.parameters,
      options.databaseCapabilities ?? { version: "unverified" }
    );
    const capacity =
      variant.databaseStartup?.parameters.find((p) => p.name === "-n")?.displayValue ??
      variant.parameters["-n"];
    if (capacity !== undefined)
      validateWriterCapacity(
        controls,
        Number(capacity),
        Math.max(parsed.target.pasReplicas, parsed.workload.load.concurrency) + 3
      );
  }
  if (request.baselineVariantId && !ids.has(request.baselineVariantId))
    throw new Error("baseline_variant_not_found");
  if (request.comparisonMode === "exploratory" && request.baselineVariantId)
    throw new Error("exploratory_baseline_forbidden");
  if (!request.inputs) throw new Error("environment_inputs_required");
  checkImageReference(request.inputs.databaseImage);
  checkImageReference(request.inputs.pasImage);
  checkCredentialReference(request.inputs.credentialRef);
  const provenance = [
    checkInputReference(request.inputs.seed, "seed", [
      options.inputRoot ?? process.cwd(),
      options.seedsRoot
    ]),
    checkInputReference(request.inputs.applicationArchive, "application_archive", options.inputRoot)
  ];
  if (options.imageInspectable === false) throw new Error("image_not_inspectable");
  if (options.dockerAvailable === false) throw new Error("docker_unavailable");
  if (options.prometheusAvailable === false) throw new Error("prometheus_unavailable");
  requireDiskIoSources(options.diskIo ?? { cadvisor: false, nodeExporterBlockDevice: false });
  if (options.hostCpu !== undefined && options.hostCpu < 1)
    throw new Error("insufficient_host_cpu");
  if (options.freeBytes !== undefined && options.freeBytes < 1024 * 1024 * 1024)
    throw new Error("insufficient_free_storage");
  return {
    scenario: parsed,
    inputs: {
      ...request.inputs,
      databaseImage: request.inputs.databaseImage,
      pasImage: request.inputs.pasImage
    },
    provenance,
    warnings: []
  };
}
