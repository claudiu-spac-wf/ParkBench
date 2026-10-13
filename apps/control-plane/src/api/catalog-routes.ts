import { Platform } from "../platform";
import { sendControlUiError, queryString } from "./control-ui-errors";
import { ScenarioFileSource } from "../catalog/scenario-source";
import { CATALOG_WORKFLOW_CONTRACT_VERSION, CatalogActionKind } from "../../../../packages/contracts/src/catalog";
import path from "node:path";
import { readArchiveContents } from "../catalog/archive-contents";

const retired = (reply: any) => { reply.code(410); return { error: "operation_retired" }; };

export function registerCatalogRoutes(app: any, platform: Platform): void {
  app.get("/api/v1/catalog/assets", async (request: any) => {
    const category = queryString(request, "category");
    await platform.discovery.refresh();
    const items: any[] = category === "scenarios"
      ? new ScenarioFileSource(platform.config.discoveryRoots?.scenarios).list()
      : platform.discovery.getAssets().filter((asset) => asset.category !== "scenarios");
    const filtered = items.filter((item) =>
      (!category || item.category === category) &&
      (!queryString(request, "kind") || item.kind === queryString(request, "kind")) &&
      (!queryString(request, "name") || String(item.displayName ?? item.name).includes(queryString(request, "name")!)));
    const latest = new Map<string, { kind: string; state: "PASSED" | "FAILED"; checkedAt: string }>();
    for (const action of platform.controlRepository.listCatalogActions()) for (const result of action.results) {
      const key = `${action.kind}:${result.path}`;
      if (!latest.has(key)) latest.set(key, { kind: action.kind, state: result.state, checkedAt: result.checkedAt });
    }
    const withActions = filtered.map((item) => {
      const relativePath = item.relativePath ?? item.provenance?.relativePath;
      const kind = item.category === "scenarios" ? "VERIFY_SCENARIOS" :
        item.category === "workloads" ? "COMPILE_WORKLOADS" : undefined;
      let archiveContents;
      let archiveError;
      if (item.category === "archives" && platform.config.discoveryRoots?.archives && relativePath) {
        try { archiveContents = readArchiveContents(path.join(platform.config.discoveryRoots.archives, relativePath)); }
        catch (error) { archiveError = String(error); }
      }
      return { ...item, lastAction: kind ? latest.get(`${kind}:${relativePath}`) : undefined,
        archiveContents, archiveError };
    });
    const start = Math.max(0, Number(queryString(request, "pageToken") ?? 0) || 0);
    const size = Math.max(1, Math.min(250, Number(queryString(request, "pageSize") ?? 50) || 50));
    return { contractVersion: CATALOG_WORKFLOW_CONTRACT_VERSION,
      items: withActions.slice(start, start + size),
      nextPageToken: start + size < withActions.length ? String(start + size) : undefined,
      hasMore: start + size < withActions.length };
  });
  app.get("/api/v1/catalog/discovery", async () => platform.discovery.getSnapshot());
  app.post("/api/v1/catalog/discovery/refresh", async (_request: any, reply: any) => {
    try { return await platform.discovery.refresh(); }
    catch (error) { return sendControlUiError(reply, error, "catalog_discovery_refresh_failed", 503); }
  });
  app.get("/api/v1/catalog/assets/:assetId", async (request: any, reply: any) => {
    const scenario = new ScenarioFileSource(platform.config.discoveryRoots?.scenarios).list()
      .find((item) => item.id === request.params.assetId);
    const asset = scenario ?? platform.controlUi.getAsset(request.params.assetId);
    return asset ?? sendControlUiError(reply, new Error("asset_not_found"), "asset_not_found", 404);
  });
  app.post("/api/v1/catalog/assets/import", async (_request: any, reply: any) => retired(reply));
  app.post("/api/v1/catalog/assets/:assetId/verify", async (_request: any, reply: any) => retired(reply));

  app.post("/api/v1/catalog/actions", async (request: any, reply: any) => {
    try {
      const key = request.headers?.["idempotency-key"];
      if (typeof key === "string" && key) {
        const prior = platform.controlRepository.getCommandResult("catalog-action", key);
        if (prior) { reply.code(prior.statusCode); return prior.response; }
      }
      const body = request.body ?? {};
      const action = platform.catalogActions.start(body.kind as CatalogActionKind, body.archiveName);
      const response = { contractVersion: CATALOG_WORKFLOW_CONTRACT_VERSION, operationId: action.id, ...action };
      reply.code(202);
      if (typeof key === "string" && key)
        platform.controlRepository.saveCommandResult("catalog-action", key, 202, response);
      return response;
    } catch (error) { return sendControlUiError(reply, error, "catalog_action_invalid"); }
  });
  app.get("/api/v1/catalog/actions/:operationId", async (request: any, reply: any) => {
    const action = platform.catalogActions.get(request.params.operationId);
    return action ? { operationId: action.id, ...action } :
      sendControlUiError(reply, new Error("catalog_action_not_found"), "catalog_action_not_found", 404);
  });
}
