import fs from "node:fs";
import path from "node:path";
import { CatalogAsset } from "../../../../packages/contracts/src/control-ui";
import { isSelectableAsset } from "./asset-state";

export type ManagedInputKind = "seed" | "archive";

export function resolveManagedInputPath(
  asset: CatalogAsset | undefined,
  reference: string,
  kind: ManagedInputKind,
  roots: Partial<Record<"seeds" | "archives", string>>
): string {
  if (!asset || asset.kind !== kind || asset.immutableRef !== reference || !isSelectableAsset(asset))
    throw new Error(`asset_not_selectable:${kind}`);

  const rootKey = kind === "seed" ? "seeds" : "archives";
  const provenance = asset.provenance as Record<string, unknown>;
  const relativePath = provenance.relativePath;
  const configuredRoot = roots[rootKey];
  if (provenance.rootKey !== rootKey || typeof relativePath !== "string" || !configuredRoot)
    throw new Error("managed_input_path_unavailable");

  try {
    const realRoot = fs.realpathSync(path.resolve(configuredRoot));
    const candidate = path.resolve(realRoot, relativePath);
    if (!isWithin(candidate, realRoot)) throw new Error("managed_input_path_unavailable");
    const realFile = fs.realpathSync(candidate);
    if (!isWithin(realFile, realRoot)) throw new Error("managed_input_path_unavailable");
    // Seeds are database folders holding a <db>.db file; archives are files.
    const usable =
      kind === "seed"
        ? fs.statSync(realFile).isDirectory() &&
          fs.readdirSync(realFile).some((file) => file.endsWith(".db"))
        : fs.statSync(realFile).isFile();
    if (!usable) throw new Error("managed_input_path_unavailable");
    return realFile;
  } catch (error) {
    throw new Error("managed_input_path_unavailable");
  }
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
