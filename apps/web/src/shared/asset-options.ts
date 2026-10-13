import { CatalogAsset } from "../../../../packages/contracts/src/control-ui";
import { isValidImageReference } from "../../../../packages/contracts/src/image-reference";

const readyStates = {
  verificationState: "VERIFIED",
  availability: "AVAILABLE",
  readiness: "READY",
  classificationState: "CLASSIFIED"
} as const;

export function configuredImageReference(asset: CatalogAsset): string | undefined {
  const immutable = asset.immutableRef;
  if (isValidImageReference(immutable)) return immutable;
  const configured = asset.provenance?.reference;
  return isValidImageReference(configured) ? configured : undefined;
}

export function managedAssetReference(asset: CatalogAsset): string | undefined {
  const reference = asset.immutableRef ?? asset.sourceRef;
  return typeof reference === "string" && reference.trim() ? reference : undefined;
}

export function isReadyManagedAsset(asset: CatalogAsset): boolean {
  return (
    asset.verificationState === readyStates.verificationState &&
    asset.availability === readyStates.availability &&
    asset.readiness === readyStates.readiness &&
    asset.classificationState === readyStates.classificationState
  );
}

export function isStaleAssetError(error: unknown): boolean {
  let detail = String(error ?? "");
  if (error && typeof error === "object") {
    try {
      detail = `${detail} ${JSON.stringify(error)}`;
    } catch {
      // Keep the direct string representation if an API error is not serializable.
    }
  }
  return /asset_not_(?:selectable|found)|asset_not_selectable_kind|scenario_asset_(?:not_found|kind_mismatch|reference_required)|managed_input_changed_since_discovery|input_asset_unusable/i.test(
    detail
  );
}

export function isCompatibleAsset(
  asset: CatalogAsset,
  expectedCompatibility: Record<string, unknown> = {}
): boolean {
  return Object.entries(expectedCompatibility).every(
    ([key, value]) => asset.compatibility?.[key] === value
  );
}

export function eligibleImageOptions(
  assets: CatalogAsset[],
  kind: "database_image" | "pas_image",
  expectedCompatibility: Record<string, unknown> = {}
): CatalogAsset[] {
  return assets.filter(
    (asset) =>
      asset.kind === kind &&
      isReadyManagedAsset(asset) &&
      configuredImageReference(asset) !== undefined &&
      isCompatibleAsset(asset, expectedCompatibility)
  );
}

export function eligibleWorkloadOptions(assets: CatalogAsset[]): CatalogAsset[] {
  return assets.filter(
    (asset) =>
      asset.kind === "workload" &&
      /\.p$/i.test(asset.name) &&
      isReadyManagedAsset(asset) &&
      Boolean(managedAssetReference(asset))
  );
}

export function eligibleManagedInputOptions(
  assets: CatalogAsset[],
  kind: "seed" | "archive"
): CatalogAsset[] {
  return assets.filter(
    (asset) =>
      asset.kind === kind && isReadyManagedAsset(asset) && Boolean(managedAssetReference(asset))
  );
}

export function eligibleScenarioCompatibility(scenario: any): Record<string, unknown> {
  const value = scenario?.compatibility ?? scenario?.target?.compatibility;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function hasConfiguredDefault(value: any): boolean {
  const provenance = value?.provenance;
  return Boolean(
    provenance?.configuredDefault === true ||
      provenance?.isDefault === true ||
      provenance?.source === "configured-local-input"
  );
}

export function defaultChoice<T>(
  choices: T[],
  getConfiguredDefault: (choice: T) => boolean = hasConfiguredDefault
): { choice: T; reason: "configured" | "sole" } | undefined {
  const configured = choices.filter(getConfiguredDefault);
  if (configured.length === 1) return { choice: configured[0], reason: "configured" };
  if (choices.length === 1) return { choice: choices[0], reason: "sole" };
  return undefined;
}

export function choiceStatus<T>(
  choices: T[],
  value: string,
  getValue: (choice: T) => string | undefined,
  getConfiguredDefault: (choice: T) => boolean = hasConfiguredDefault
): string {
  const selected = choices.find((choice) => getValue(choice) === value);
  if (!selected)
    return choices.length > 1
      ? `Choose explicitly from ${choices.length} ready options.`
      : choices.length === 1
        ? "Choose the only ready option."
        : "No ready options are available.";
  if (getConfiguredDefault(selected)) return "Default: configured locally.";
  if (choices.length === 1) return "Default: only ready option.";
  return "Selected explicitly.";
}
