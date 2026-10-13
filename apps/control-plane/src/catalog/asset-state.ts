import { CatalogAsset, VerificationState } from "../../../../packages/contracts/src";
import {
  isValidImageReference,
  parseImageReference
} from "../../../../packages/contracts/src/image-reference";

const transitions: Record<VerificationState, VerificationState[]> = {
  UNVERIFIED: ["VERIFYING", "STALE"],
  VERIFYING: ["VERIFIED", "FAILED", "STALE"],
  VERIFIED: ["VERIFYING", "STALE"],
  STALE: ["VERIFYING", "FAILED"],
  FAILED: ["VERIFYING", "STALE"]
};

export function canTransitionAssetState(from: VerificationState, to: VerificationState): boolean {
  return from === to || transitions[from].includes(to);
}

export function isSelectableAsset(
  asset: CatalogAsset,
  expectedCompatibility: Record<string, unknown> = {}
): boolean {
  if (asset.verificationState !== "VERIFIED") return false;
  if (asset.availability && asset.availability !== "AVAILABLE") return false;
  if (asset.readiness && asset.readiness !== "READY") return false;
  if (asset.classificationState && asset.classificationState !== "CLASSIFIED") return false;
  if (!asset.immutableRef && !asset.provenance?.reference) return false;
  if (
    asset.category === "docker_images" &&
    !isValidImageReference(asset.provenance?.reference ?? asset.immutableRef)
  )
    return false;
  return Object.entries(expectedCompatibility).every(
    ([key, value]) => asset.compatibility?.[key] === value
  );
}

export function imageAssetMatchesReference(asset: CatalogAsset, reference: string): boolean {
  if (!new Set(["database_image", "pas_image", "observer_image", "loadgen_image"]).has(asset.kind))
    return false;
  if (asset.immutableRef === reference || asset.provenance?.reference === reference)
    return true;
  const candidate = asset.provenance?.reference ?? asset.immutableRef;
  if (typeof candidate !== "string") return false;
  try {
    const configured = parseImageReference(reference);
    const discovered = parseImageReference(candidate);
    return (
      configured.repository === discovered.repository &&
      configured.tag === discovered.tag
    );
  } catch {
    return false;
  }
}

export function findSelectableImageAsset(
  assets: CatalogAsset[], reference: string
): CatalogAsset | undefined {
  return assets.find((asset) => imageAssetMatchesReference(asset, reference) && isSelectableAsset(asset));
}

export function assertSelectableAsset(
  asset: CatalogAsset | undefined,
  expectedCompatibility: Record<string, unknown> = {}
): CatalogAsset {
  if (!asset) throw new Error("asset_not_found");
  if (!isSelectableAsset(asset, expectedCompatibility))
    throw new Error(`asset_not_selectable:${asset.id}`);
  return asset;
}
