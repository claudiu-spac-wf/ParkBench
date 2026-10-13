import type {
  ComparisonResult,
  ComparisonTablePage,
  SelectionPage
} from "../../../../packages/contracts/src/comparison";
import { api, idempotencyKey } from "../api";
import { CatalogAsset, UiOptionsV1 } from "../../../../packages/contracts/src/control-ui";

export interface CatalogAssetPage {
  items: CatalogAsset[];
  nextPageToken?: string;
  hasMore?: boolean;
}

export const getCatalog = (query = "") => api<any>(`/catalog/assets${query ? `?${query}` : ""}`);
export async function getAllCatalog(query = ""): Promise<CatalogAssetPage> {
  const parameters = new URLSearchParams(query.replace(/^\?/, ""));
  const items: CatalogAsset[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let snapshot: any = {};
  do {
    if (pageToken) parameters.set("pageToken", pageToken);
    else parameters.delete("pageToken");
    const suffix = parameters.toString();
    snapshot = await api<CatalogAssetPage>(`/catalog/assets${suffix ? `?${suffix}` : ""}`);
    items.push(...(snapshot.items ?? []));
    const next = snapshot.nextPageToken;
    if (!next) {
      if (snapshot.hasMore) throw new Error("catalog_pagination_token_missing");
      pageToken = undefined;
      break;
    }
    if (seenTokens.has(next)) throw new Error("catalog_pagination_token_repeated");
    seenTokens.add(next);
    pageToken = next;
  } while (pageToken);
  return { ...snapshot, items, nextPageToken: undefined, hasMore: false };
}
export const getUiOptions = () => api<UiOptionsV1>("/ui-options");
export const getCatalogDiscovery = () => api<any>("/catalog/discovery");
export const refreshCatalogDiscovery = () =>
  api<any>("/catalog/discovery/refresh", { method: "POST", body: "{}" });
export const startCatalogAction = (
  kind: "VERIFY_SCENARIOS" | "COMPILE_WORKLOADS" | "REBUILD_ARCHIVE",
  archiveName?: string
) =>
  api<any>("/catalog/actions", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: JSON.stringify({ kind, archiveName })
  });
export const getCatalogAction = (id: string) =>
  api<any>(`/catalog/actions/${encodeURIComponent(id)}`);
export const getOverview = () => api<any>("/overview");
export const importCatalogAsset = (body: unknown) =>
  api<any>("/catalog/assets/import", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: JSON.stringify(body)
  });
export const verifyAsset = (id: string) =>
  api<any>(`/catalog/assets/${encodeURIComponent(id)}/verify`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: "{}"
  });
export const startImageOperation = (body: unknown) =>
  api<any>("/image-operations", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: JSON.stringify(body)
  });
export const getImageOperation = (id: string) =>
  api<any>(`/image-operations/${encodeURIComponent(id)}`).then((operation) => ({
    ...operation,
    operationId: operation.operationId ?? operation.id
  }));
export const cancelImageOperation = (id: string) =>
  api<any>(`/image-operations/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: "{}"
  });
export const retryImageOperation = (id: string) =>
  api<any>(`/image-operations/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: "{}"
  });
export const getControlScenarios = () => api<any>("/scenarios");
export const getControlScenario = (id: string, version: string) =>
  api<any>(`/scenarios/${encodeURIComponent(id)}/${encodeURIComponent(version)}`);
export const saveControlScenario = (id: string, body: unknown) =>
  api<any>(`/scenarios/${encodeURIComponent(id)}/versions`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: JSON.stringify(body)
  });
export const previewMatrix = (body: unknown) =>
  api<any>("/experiments/preview", { method: "POST", body: JSON.stringify(body) });
export const getPreviewCells = (id: string, pageToken?: string) =>
  api<any>(
    `/experiments/previews/${encodeURIComponent(id)}/cells${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`
  );
export const submitPreview = (body: unknown) =>
  api<any>("/experiments/submit", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: JSON.stringify(body)
  });
export const getQueue = () => api<any>("/queue");
export const startQueue = () =>
  api<any>("/queue/start", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: "{}"
  });
export const cancelControlRun = (id: string) =>
  api<any>(`/queue/runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: "{}"
  });
export const getControlExperiments = () => api<any>("/experiments");
export const getControlExperiment = (id: string) =>
  api<any>(`/experiments/${encodeURIComponent(id)}`);
export const getControlRuns = (id: string) =>
  api<any>(`/experiments/${encodeURIComponent(id)}/runs`);
export const getControlRun = (id: string) => api<any>(`/runs/${encodeURIComponent(id)}`);
export const createComparison = (body: unknown) =>
  api<ComparisonResult>("/comparisons", { method: "POST", body: JSON.stringify(body) });
const comparisonQuery = (options: { cursor?: string; limit?: number }) => {
  const query = new URLSearchParams();
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.limit) query.set("limit", String(options.limit));
  return query.size ? "?" + query.toString() : "";
};
export const getComparison = (id: string, options: { cursor?: string; limit?: number } = {}) =>
  api<ComparisonResult>(`/comparisons/${encodeURIComponent(id)}${comparisonQuery(options)}`);
export const getComparisonSelection = (
  id: string,
  options: { cursor?: string; limit?: number } = {}
) =>
  api<{ id: string; selectionRevision: number; selectionPage: SelectionPage }>(
    `/comparisons/${encodeURIComponent(id)}/selection${comparisonQuery(options)}`
  );
export const getComparisonTables = (
  id: string,
  runId: string,
  options: { cursor?: string; limit?: number } = {}
) =>
  api<ComparisonTablePage>(
    `/comparisons/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/tables${comparisonQuery(options)}`
  );
export const comparisonExportUrl = (comparisonId: string) =>
  `/api/v1/comparisons/${encodeURIComponent(comparisonId)}/export`;
export const getDashboardContext = (id: string) =>
  api<any>(`/dashboards/context/${encodeURIComponent(id)}`);
export const getHistory = (query = "") => api<any>(`/history/runs${query ? `?${query}` : ""}`);
export const getHistoryDetail = (id: string) => api<any>(`/history/runs/${encodeURIComponent(id)}`);
