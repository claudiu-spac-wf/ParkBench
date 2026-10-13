import {
  CatalogAsset,
  CatalogCategoryKey,
  CatalogDiscoverySnapshot,
  DiscoverySourceStatus
} from "../../../../packages/contracts/src";
import { ControlUiRepository } from "../storage/control-ui-repository";
import {
  DockerDiscoveryProvider
} from "./docker-discovery";
import { FileDiscoveryResult, ManagedRootFileDiscovery, ManagedRootKey } from "./file-discovery";

const categoryLabels: Partial<Record<CatalogCategoryKey, string>> = {
  scenarios: "Scenarios",
  workloads: "Workloads",
  observers: "Observers",
  seeds: "Seeds",
  archives: "Archives"
};

export interface DiscoveryProviders {
  docker: DockerDiscoveryProvider;
  filesystem: ManagedRootFileDiscovery;
}

export class CatalogDiscoveryService {
  private assets: CatalogAsset[] = [];
  private snapshot: CatalogDiscoverySnapshot = {
    contractVersion: "catalog-discovery.v1",
    refreshState: "IDLE",
    categories: Object.keys(categoryLabels).map((key) => ({
      key: key as CatalogCategoryKey,
      label: categoryLabels[key as CatalogCategoryKey]!,
      count: 0,
      readyCount: 0,
      staleCount: 0,
      sourceState: "PENDING"
    })),
    sources: []
  };
  private refreshPromise?: Promise<CatalogDiscoverySnapshot>;

  constructor(
    private readonly repository: ControlUiRepository,
    private readonly providers: DiscoveryProviders
  ) {}

  getSnapshot(): CatalogDiscoverySnapshot {
    return structuredClone(this.snapshot);
  }

  getAssets(): CatalogAsset[] {
    return structuredClone(this.assets);
  }

  refresh(): Promise<CatalogDiscoverySnapshot> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.runRefresh().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async runRefresh(): Promise<CatalogDiscoverySnapshot> {
    this.snapshot = { ...this.snapshot, refreshState: "RUNNING" };
    const startedAt = new Date().toISOString();
    const sourceResults = this.providers.filesystem.discoverAll(startedAt);
    this.assets = sourceResults.flatMap((result) => result.items.map((item) => ({
      ...item, createdAt: item.discoveredAt, updatedAt: item.lastSeenAt
    } as CatalogAsset)));
    const sources = sourceResults.map((result) => this.sourceStatus(result, startedAt));
    const sourceFailed = sourceResults.some((result) => result.state === "FAILED");
    const sourceDegraded = sourceResults.some((result) => result.state === "DEGRADED");
    const refreshState = sourceFailed || sourceDegraded ? "PARTIAL" : "SUCCEEDED";
    const assets = this.assets;
    const categories = (Object.keys(categoryLabels) as CatalogCategoryKey[]).map((key) => {
      const categoryAssets = assets.filter((asset) => asset.category === key);
      const sourceStates = sourcesForCategory(key, sources);
      return {
        key,
        label: categoryLabels[key]!,
        count: categoryAssets.length,
        readyCount: categoryAssets.filter((asset) => asset.readiness === "READY").length,
        staleCount: categoryAssets.filter((asset) =>
          ["STALE", "UNAVAILABLE"].includes(asset.availability ?? "")
        ).length,
        sourceState: sourceStates.length
          ? sourceStates.some((source) => source.state === "FAILED")
            ? "FAILED"
            : sourceStates.some((source) => ["DEGRADED", "READY"].includes(source.state))
              ? (sourceStates.find((source) => source.state === "DEGRADED")?.state ?? "READY")
              : "EMPTY"
          : "EMPTY"
      };
    });
    this.snapshot = {
      contractVersion: "catalog-discovery.v1",
      refreshedAt: new Date().toISOString(),
      refreshState,
      categories,
      sources
    };
    return this.getSnapshot();
  }

  private sourceStatus(
    result: FileDiscoveryResult,
    startedAt: string
  ): DiscoverySourceStatus {
    return {
      source: "filesystem",
      rootKey: result.rootKey,
      state: result.state,
      itemCount: result.itemCount,
      lastStartedAt: startedAt,
      lastCompletedAt: new Date().toISOString(),
      error: result.error
    };
  }
}

function sourcesForCategory(
  key: CatalogCategoryKey,
  sources: DiscoverySourceStatus[]
): DiscoverySourceStatus[] {
  return sources.filter((source) => source.rootKey === key);
}

export function fakeDiscoveryProviders(): DiscoveryProviders {
  const emptyDocker = {
    async listLocalImages() {
      return [];
    }
  };
  const emptyRoots = new ManagedRootFileDiscovery({});
  return { docker: new DockerDiscoveryProvider(emptyDocker), filesystem: emptyRoots };
}
