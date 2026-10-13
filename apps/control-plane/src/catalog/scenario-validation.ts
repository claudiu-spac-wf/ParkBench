import { ScenarioVersionRecord } from "../../../../packages/contracts/src";
import { validateParameterConfiguration } from "../../../../packages/contracts/src/matrix-expansion";
import { CatalogAsset } from "../../../../packages/contracts/src";
import { ValidationError } from "../../../../packages/contracts/src";
import { assertSelectableAsset } from "./asset-state";
import { Scenario } from "../../../../packages/contracts/src/scenario";
import { validateParameterDefinitions } from "../../../../packages/contracts/src/scenario-parameter-validation";
export {
  validateParameterDefinitions,
  validateScenarioDatabaseParameterDefinitions
} from "../../../../packages/contracts/src/scenario-parameter-validation";

export function validateRequiredMeasurements(scenario: Scenario): void {
  const measurements = scenario.requiredMeasurements ?? [];
  const observerMap = new Map(scenario.observers.map((observer) => [observer.id, observer]));
  const seen = new Set<string>();
  for (const [index, measurement] of measurements.entries()) {
    if (seen.has(measurement.id))
      throw new ValidationError(
        [{ path: `/requiredMeasurements/${index}/id`, code: "duplicate_measurement" }],
        `duplicate_measurement:${measurement.id}`
      );
    seen.add(measurement.id);
    if (measurement.source === "observer") {
      const observer = measurement.observerId ? observerMap.get(measurement.observerId) : undefined;
      if (!observer)
        throw new ValidationError(
          [{ path: `/requiredMeasurements/${index}/observerId`, code: "observer_not_found" }],
          `observer_not_found:${measurement.observerId ?? ""}`
        );
    } else if (measurement.observerId) {
      throw new ValidationError(
        [{ path: `/requiredMeasurements/${index}/observerId`, code: "observer_not_allowed" }],
        `observer_not_allowed:${measurement.id}`
      );
    }
    if (measurement.phases?.some((phase) => !["warmup", "measurement", "cooldown"].includes(phase)))
      throw new ValidationError(
        [{ path: `/requiredMeasurements/${index}/phases`, code: "phase_not_supported" }],
        `phase_not_supported:${measurement.id}`
      );
  }
}

export function validateScenarioConfiguration(
  scenario: ScenarioVersionRecord,
  values: Record<string, string | number | boolean>
): void {
  validateParameterDefinitions(scenario.parameterDefinitions);
  validateParameterConfiguration(scenario.parameterDefinitions, values);
}

export function validateScenarioAssetRefs(
  scenario: {
    assetRefs?: {
      workload?: string;
      databaseImage?: string;
      pasImage?: string;
      observers?: string[];
    };
  },
  getAsset: (idOrRef: string) => CatalogAsset | undefined
): void {
  const refs = scenario.assetRefs;
  if (!refs) return;
  const required: Array<[string, string | undefined, string]> = [
    ["workload", refs.workload, "workload"],
    ["databaseImage", refs.databaseImage, "database_image"],
    ["pasImage", refs.pasImage, "pas_image"]
  ];
  for (const [name, ref, kind] of required) {
    if (!ref) throw new Error(`scenario_asset_reference_required:${name}`);
    const asset = getAsset(ref);
    if (!asset) throw new Error(`scenario_asset_not_found:${name}`);
    if (asset.kind !== kind) throw new Error(`scenario_asset_kind_mismatch:${name}`);
    assertSelectableAsset(asset);
  }
  for (const ref of refs.observers ?? []) {
    const asset = getAsset(ref);
    if (!asset) throw new Error(`scenario_asset_not_found:observer:${ref}`);
    if (asset.kind !== "observer" && asset.kind !== "observer_image")
      throw new Error(`scenario_asset_kind_mismatch:observer:${ref}`);
    assertSelectableAsset(asset);
  }
}
