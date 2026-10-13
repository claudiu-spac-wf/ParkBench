import {
  CatalogAsset,
  CatalogAssetKind,
  CatalogCategoryKey,
  CatalogClassificationState,
  CatalogReadiness
} from "../../../../packages/contracts/src";
import { parseImageReference } from "../../../../packages/contracts/src/image-reference";

export interface LocalDockerImage {
  id?: string;
  ID?: string;
  repository?: string;
  Repository?: string;
  tag?: string;
  Tag?: string;
  labels?: Record<string, unknown>;
  Labels?: Record<string, unknown>;
  createdAt?: string;
}

export interface DiscoveryAssetCandidate {
  id: string;
  kind: CatalogAssetKind;
  category: CatalogCategoryKey;
  name: string;
  immutableRef?: string;
  compatibility: Record<string, unknown>;
  sourceRef: string;
  provenance: Record<string, unknown>;
  verificationState: "VERIFIED" | "FAILED";
  availability: "AVAILABLE" | "UNAVAILABLE";
  readiness: CatalogReadiness;
  classificationState: CatalogClassificationState;
  blockReasons: string[];
  discoverySource: "docker" | "filesystem";
  discoveryIdentity: string;
  discoveredAt: string;
  lastSeenAt: string;
}

export interface DockerDiscoveryResult {
  items: DiscoveryAssetCandidate[];
  state: "READY" | "EMPTY" | "DEGRADED" | "FAILED";
  itemCount: number;
  error?: { code: string; message: string };
}

export interface DockerImageAdapter {
  listLocalImages(): Promise<Array<Record<string, unknown>>>;
  inspectImageDetails?(image: string): Promise<Record<string, unknown> | undefined>;
}

const roleMap: Record<string, CatalogAssetKind> = {
  database: "database_image",
  db: "database_image",
  pas: "pas_image",
  pasoe: "pas_image",
  loadgen: "loadgen_image",
  load_generator: "loadgen_image",
  observer: "observer_image"
};

export class DockerDiscoveryProvider {
  constructor(private readonly adapter: DockerImageAdapter) {}

  async discover(now = new Date().toISOString()): Promise<DockerDiscoveryResult> {
    let images: Array<Record<string, unknown>>;
    try {
      images = await this.adapter.listLocalImages();
    } catch {
      return {
        items: [],
        state: "FAILED",
        itemCount: 0,
        error: {
          code: "docker_unavailable",
          message: "The local Docker image source could not be refreshed."
        }
      };
    }
    const parkBenchImages = images.filter((image) => {
      const local = image as LocalDockerImage;
      return isParkBenchRepository(local.repository ?? local.Repository);
    });
    const items = await Promise.all(parkBenchImages.map((image) => this.toAsset(image, now)));
    const byIdentity = new Map<string, DiscoveryAssetCandidate>();
    for (const item of items.filter(Boolean) as DiscoveryAssetCandidate[]) {
      const existing = byIdentity.get(item.discoveryIdentity);
      if (!existing) {
        byIdentity.set(item.discoveryIdentity, item);
        continue;
      }
      const tags = new Set<string>([
        ...((existing.provenance.tags as string[] | undefined) ??
          (existing.provenance.tag ? [String(existing.provenance.tag)] : [])),
        ...((item.provenance.tags as string[] | undefined) ??
          (item.provenance.tag ? [String(item.provenance.tag)] : []))
      ]);
      existing.provenance = { ...existing.provenance, tags: [...tags] };
    }
    const validItems = [...byIdentity.values()];
    const hasBlocked = validItems.some((item) => item.readiness !== "READY");
    return {
      items: validItems,
      state: validItems.length === 0 ? "EMPTY" : hasBlocked ? "DEGRADED" : "READY",
      itemCount: validItems.length
    };
  }

  private async toAsset(
    image: Record<string, unknown>,
    now: string
  ): Promise<DiscoveryAssetCandidate | undefined> {
    const local = image as LocalDockerImage;
    const repository = stringValue(local.repository ?? local.Repository) ?? "<untagged>";
    const tag = stringValue(local.tag ?? local.Tag) ?? "latest";
    const imageId = stringValue(local.id ?? local.ID) ?? `${repository}:${tag}`;
    const inspected = await this.adapter.inspectImageDetails?.(imageId);
    const inspectedRecord = inspected as any;
    const labels = safeLabels(local.labels ?? local.Labels ?? inspectedRecord?.Config?.Labels);
    const reference = `${repository}:${tag}`;
    const role = classifyRole(repository, labels);
    const kind = role ?? "docker_image";
    const discoveryIdentity = `${kind}:${reference}`;
    const id = `discovery_docker_${Buffer.from(discoveryIdentity).toString("base64url")}`;
    const immutableRef = reference;
    const blockReasons: string[] = [];
    if (!role) blockReasons.push("role_unrecognized");
    try {
      parseImageReference(reference);
    } catch (error) {
      const code = String(error).replace(/^Error:\s*/, "");
      blockReasons.push(
        code.includes("latest")
          ? "image_latest_forbidden"
          : code.includes("tag")
            ? "image_tag_required"
            : "image_reference_invalid"
      );
    }
    const readiness: CatalogReadiness = blockReasons.length ? "NOT_READY" : "READY";
    return {
      id,
      kind,
      category: "docker_images",
      name: `${repository}:${tag}`,
      immutableRef,
      compatibility: { role: role ?? "unknown" },
      sourceRef: `docker:${reference}`,
      provenance: {
        source: "docker",
        repository,
        tag,
        reference,
        labels
      },
      verificationState: readiness === "READY" ? "VERIFIED" : "FAILED",
      availability: "AVAILABLE",
      readiness,
      classificationState: role ? "CLASSIFIED" : "UNCLASSIFIED",
      blockReasons,
      discoverySource: "docker",
      discoveryIdentity,
      discoveredAt: now,
      lastSeenAt: now
    };
  }
}

export function isParkBenchRepository(value: unknown): value is string {
  return typeof value === "string" && value.trim().startsWith("parkbench/");
}

export function isParkBenchDockerDiscoveryAsset(
  asset: Pick<CatalogAsset, "discoverySource" | "provenance">
): boolean {
  return (
    asset.discoverySource !== "docker" ||
    isParkBenchRepository((asset.provenance as any)?.repository)
  );
}

function classifyRole(
  repository: string,
  labels: Record<string, string>
): CatalogAssetKind | undefined {
  const labelRole = labels["com.parkbench.role"] ?? labels["parkbench.role"];
  const candidate = String(labelRole ?? repository).toLowerCase();
  for (const [role, kind] of Object.entries(roleMap)) {
    if (candidate === role || candidate.endsWith(`/${role}`) || candidate.includes(`-${role}`))
      return kind;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && !["<none>", "none", "-"].includes(normalized.toLowerCase())
    ? normalized
    : undefined;
}

function safeLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key, item]) =>
          /^(com\.parkbench\.role|parkbench\.role|org\.opencontainers\.image\.(title|version|revision))$/i.test(
            key
          ) && typeof item === "string"
      )
      .map(([key, item]) => [key, String(item)])
  );
}
