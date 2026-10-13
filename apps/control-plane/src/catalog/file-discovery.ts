import fs from "node:fs";
import path from "node:path";
import { validateScenario } from "../../../../packages/contracts/src/validator";
import { validateSeedDirectory } from "../../../../packages/contracts/src/seed";
import { CatalogAssetKind, CatalogCategoryKey } from "../../../../packages/contracts/src";
import { DiscoveryAssetCandidate } from "./docker-discovery";

export type ManagedRootKey = Exclude<CatalogCategoryKey, "docker_images">;

export interface FileDiscoveryResult {
  rootKey: ManagedRootKey;
  items: Array<
    DiscoveryAssetCandidate & { category: ManagedRootKey; discoverySource: "filesystem" }
  >;
  state: "READY" | "EMPTY" | "DEGRADED" | "FAILED";
  itemCount: number;
  error?: { code: string; message: string };
}

const kindByRoot: Record<ManagedRootKey, CatalogAssetKind> = {
  scenarios: "scenario",
  workloads: "workload",
  observers: "observer",
  seeds: "seed",
  archives: "archive",
  configs: "config"
};

export class ManagedRootFileDiscovery {
  constructor(
    private readonly roots: Partial<Record<ManagedRootKey, string>>,
    private readonly maxFiles = 10_000
  ) {}

  discoverAll(now = new Date().toISOString()): FileDiscoveryResult[] {
    return (["scenarios", "workloads", "observers", "seeds", "archives"] as ManagedRootKey[]).map(
      (rootKey) => this.discoverRoot(rootKey, now)
    );
  }

  discoverRoot(rootKey: ManagedRootKey, now = new Date().toISOString()): FileDiscoveryResult {
    const configured = this.roots[rootKey];
    if (!configured) return { rootKey, items: [], state: "EMPTY", itemCount: 0 };
    const root = path.resolve(configured);
    if (!fs.existsSync(root)) return { rootKey, items: [], state: "EMPTY", itemCount: 0 };
    try {
      const realRoot = fs.realpathSync(root);
      if (rootKey === "seeds") return this.discoverSeeds(realRoot, now);
      const files = walk(realRoot, realRoot, this.maxFiles);
      const byIdentity = new Map<
        string,
        DiscoveryAssetCandidate & { category: ManagedRootKey; discoverySource: "filesystem" }
      >();
      let invalid = 0;
      for (const file of files) {
        if (rootKey === "scenarios" && path.extname(file).toLowerCase() !== ".json") continue;
        if (rootKey === "workloads" && path.extname(file).toLowerCase() !== ".p") continue;
        if (rootKey === "archives" && path.extname(file).toLowerCase() !== ".zip") continue;
        let candidate: DiscoveryAssetCandidate & {
          category: ManagedRootKey;
          discoverySource: "filesystem";
        };
        try {
          candidate = this.toAsset(rootKey, realRoot, file, now);
        } catch (error) {
          candidate = this.unreadableAsset(rootKey, realRoot, file, now, error);
        }
        if (candidate.classificationState === "INVALID") invalid += 1;
        const existing = byIdentity.get(candidate.discoveryIdentity);
        if (existing) {
          const provenance = Array.isArray(existing.provenance.provenance)
            ? existing.provenance.provenance
            : [existing.provenance];
          existing.provenance = { provenance: [...provenance, candidate.provenance] };
        } else byIdentity.set(candidate.discoveryIdentity, candidate);
      }
      const items = [...byIdentity.values()];
      return {
        rootKey,
        items,
        state: items.length === 0 ? "EMPTY" : invalid ? "DEGRADED" : "READY",
        itemCount: items.length
      };
    } catch {
      return {
        rootKey,
        items: [],
        state: "FAILED",
        itemCount: 0,
        error: {
          code: "filesystem_root_unavailable",
          message: `The managed ${rootKey} source could not be read.`
        }
      };
    }
  }

  /**
   * Seeds are on-disk databases: each immediate child folder holding a `<db>.db` file is one
   * asset. Dot folders, other folders and loose files are ignored.
   */
  private discoverSeeds(realRoot: string, now: string): FileDiscoveryResult {
    const items: FileDiscoveryResult["items"] = [];
    let invalid = 0;
    for (const entry of fs.readdirSync(realRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(realRoot, entry.name);
      if (!fs.readdirSync(directory).some((file) => file.endsWith(".db"))) continue;
      const discoveryIdentity = `seeds:seed:${entry.name}`;
      const blockReasons: string[] = [];
      let compatibility: Record<string, unknown> = { logicalType: "seed" };
      const name = entry.name;
      try {
        const seed = validateSeedDirectory(directory);
        compatibility = {
          logicalType: "seed",
          databaseName: seed.databaseName,
          sizeBytes: seed.sizeBytes
        };
      } catch (error) {
        blockReasons.push(String((error as Error)?.message ?? error));
      }
      const ready = blockReasons.length === 0;
      if (!ready) invalid += 1;
      items.push({
        id: `discovery_file_${Buffer.from(discoveryIdentity).toString("base64url")}`,
        kind: "seed",
        category: "seeds",
        name,
        immutableRef: `input:seeds/${entry.name}`,
        compatibility,
        sourceRef: `input:seeds/${entry.name}`,
        provenance: { source: "filesystem", rootKey: "seeds", relativePath: entry.name },
        verificationState: ready ? "VERIFIED" : "FAILED",
        availability: "AVAILABLE",
        readiness: ready ? "READY" : "NOT_READY",
        classificationState: ready ? "CLASSIFIED" : "INVALID",
        blockReasons,
        discoverySource: "filesystem",
        discoveryIdentity,
        discoveredAt: now,
        lastSeenAt: now
      });
    }
    return {
      rootKey: "seeds",
      items,
      state: items.length === 0 ? "EMPTY" : invalid ? "DEGRADED" : "READY",
      itemCount: items.length
    };
  }

  private toAsset(
    rootKey: ManagedRootKey,
    realRoot: string,
    file: string,
    now: string
  ): DiscoveryAssetCandidate & { category: ManagedRootKey; discoverySource: "filesystem" } {
    const relativePath = path.relative(realRoot, file).split(path.sep).join("/");
    const kind = kindByRoot[rootKey];
    let classificationState: "CLASSIFIED" | "INVALID" = "CLASSIFIED";
    const blockReasons: string[] = [];
    if (rootKey === "scenarios") {
      try {
        validateScenario(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        classificationState = "INVALID";
        blockReasons.push("file_invalid");
      }
    }
    const discoveryIdentity = `${rootKey}:${kind}:${relativePath}`;
    const id = `discovery_file_${Buffer.from(discoveryIdentity).toString("base64url")}`;
    const ready = classificationState === "CLASSIFIED";
    return {
      id,
      kind,
      category: rootKey,
      name: path.basename(file),
      immutableRef: `input:${rootKey}/${relativePath}`,
      compatibility: { logicalType: kind },
      sourceRef: `input:${rootKey}/${relativePath}`,
      provenance: { source: "filesystem", rootKey, relativePath },
      verificationState: ready ? "VERIFIED" : "FAILED",
      availability: "AVAILABLE",
      readiness: ready ? "READY" : "NOT_READY",
      classificationState,
      blockReasons,
      discoverySource: "filesystem",
      discoveryIdentity,
      discoveredAt: now,
      lastSeenAt: now
    };
  }

  private unreadableAsset(
    rootKey: ManagedRootKey,
    realRoot: string,
    file: string,
    now: string,
    error: unknown
  ): DiscoveryAssetCandidate & { category: ManagedRootKey; discoverySource: "filesystem" } {
    const relativePath = path.relative(realRoot, file).split(path.sep).join("/");
    const kind = kindByRoot[rootKey];
    return {
      id: `discovery_file_${Buffer.from(`${rootKey}:${kind}:${relativePath}`).toString("base64url")}`,
      kind,
      category: rootKey,
      name: path.basename(file),
      immutableRef: `input:${rootKey}/${relativePath}`,
      sourceRef: `input:${rootKey}/${relativePath}`,
      compatibility: { logicalType: kind },
      provenance: { source: "filesystem", rootKey, relativePath },
      verificationState: "FAILED",
      availability: "UNAVAILABLE",
      readiness: "NOT_READY",
      classificationState: "INVALID",
      blockReasons: [`file_unreadable:${String(error)}`],
      discoverySource: "filesystem",
      discoveryIdentity: `${rootKey}:${kind}:${relativePath}`,
      discoveredAt: now,
      lastSeenAt: now
    };
  }
}

function walk(root: string, current: string, maxFiles: number): string[] {
  if (!isWithin(current, root)) throw new Error("discovery_root_escape");
  const result: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (result.length >= maxFiles) break;
    const candidate = path.join(current, entry.name);
    let resolved: string;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (!isWithin(resolved, root)) continue;
    if (entry.isDirectory()) result.push(...walk(root, resolved, maxFiles - result.length));
    else if (entry.isFile()) result.push(resolved);
  }
  return result;
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
