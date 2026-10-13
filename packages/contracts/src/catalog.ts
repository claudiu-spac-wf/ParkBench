import { Scenario } from "./scenario";

export const CATALOG_WORKFLOW_CONTRACT_VERSION = "catalog-workflow.v2" as const;
export const CATALOG_DISCOVERY_CONTRACT_VERSION = "catalog-discovery.v2" as const;
export const DISK_CATALOG_CATEGORIES = [
  "scenarios", "workloads", "observers", "seeds", "archives"
] as const;
export type DiskCatalogCategoryKey = (typeof DISK_CATALOG_CATEGORIES)[number];

export interface DiskCatalogItem {
  id: string;
  category: DiskCatalogCategoryKey;
  kind: "scenario" | "workload" | "observer" | "seed" | "archive";
  relativePath: string;
  displayName: string;
  sourceStatus: "AVAILABLE" | "INVALID" | "UNAVAILABLE";
  failureReasons: string[];
  declaredScenarioId?: string;
  declaredScenarioVersion?: string;
  lastAction?: { kind: string; state: "PASSED" | "FAILED"; checkedAt: string };
}

export type CatalogActionKind = "VERIFY_SCENARIOS" | "COMPILE_WORKLOADS" | "REBUILD_ARCHIVE";
export type CatalogActionState = "PENDING" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
export interface CatalogActionResult {
  path: string;
  state: "PASSED" | "FAILED";
  checkedAt: string;
  reasonCode?: string;
  message?: string;
}
export interface CatalogAction {
  contractVersion: typeof CATALOG_WORKFLOW_CONTRACT_VERSION;
  id: string;
  kind: CatalogActionKind;
  state: CatalogActionState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  results: CatalogActionResult[];
  outputArchive?: string;
  archiveName?: string;
  error?: { code: string; message: string };
}

export type CatalogCategoryKey =
  "docker_images" | "scenarios" | "workloads" | "observers" | "seeds" | "archives" | "configs";

export type CatalogAssetKind =
  | "scenario"
  | "workload"
  | "database_image"
  | "pas_image"
  | "loadgen_image"
  | "observer_image"
  | "docker_image"
  | "observer"
  | "seed"
  | "archive"
  | "config";

export type CatalogAvailability = "AVAILABLE" | "STALE" | "UNAVAILABLE";
export type CatalogReadiness = "READY" | "NOT_READY";
export type CatalogClassificationState = "CLASSIFIED" | "UNCLASSIFIED" | "INVALID";
export type DiscoverySourceState = "PENDING" | "READY" | "EMPTY" | "DEGRADED" | "FAILED";
export type DiscoveryRefreshState = "IDLE" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
export type ServiceHealthState = "healthy" | "degraded" | "unavailable" | "unknown";
export class VersionedCatalog {
  private documents = new Map<string, Scenario>();
  add(scenario: Scenario): void {
    const key = `${scenario.id}@${scenario.version}`;
    if (this.documents.has(key)) throw new Error("catalog_version_exists");
    this.documents.set(key, structuredClone(scenario));
  }
  get(id: string, version: string): Scenario | undefined {
    const value = this.documents.get(`${id}@${version}`);
    return value && structuredClone(value);
  }
  list(): Scenario[] {
    return [...this.documents.values()].map((value) => structuredClone(value));
  }
}
