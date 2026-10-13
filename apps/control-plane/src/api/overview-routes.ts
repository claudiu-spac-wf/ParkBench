import { OverviewSnapshot, ServiceHealthState } from "../../../../packages/contracts/src";
import { Platform } from "../platform";

export function registerOverviewRoutes(app: any, platform: Platform): void {
  app.get("/api/v1/overview", async () => {
    const checkedAt = new Date().toISOString();
    const [docker, prometheus] = await Promise.all([
      safeHealth(() => platform.orchestrator.health?.()),
      safeHealth(() => platform.prometheus.health())
    ]);
    const queueItems = platform.controlUi.listLifecycleRuns();
    const active = platform.controlUi.listExperiments({ status: "RUNNING" })[0];
    const retryTimes = queueItems
      .map((run) => run.nextRetryAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    const history = platform.controlUi.historyPage({}, undefined, 10).items;
    const response: OverviewSnapshot = {
      contractVersion: "overview.v1",
      health: {
        sqlite: "healthy",
        docker,
        prometheus,
        checkedAt
      },
      discovery: platform.discovery.getSnapshot(),
      queue: {
        activeExperiment: active?.id ?? null,
        queued: queueItems.filter((run) => run.queueState === "QUEUED").length,
        running: queueItems.filter((run) => ["PROVISIONING", "DB_READY", "PAS_READY", "WARMING_UP", "MEASURING", "COOLDOWN", "FINALIZING", "RUNNING"].includes(run.queueState)).length,
        blocked: queueItems.filter((run) => run.queueState === "BLOCKED").length,
        nextRetryAt: retryTimes[0] ?? null
      },
      recentRuns: history.map((run: any) => ({
        id: String(run.id),
        experimentId: String(run.experimentId),
        state: String(run.state ?? run.status),
        updatedAt: String(run.updatedAt ?? run.timestamps?.updatedAt ?? checkedAt),
        summary: run.evidence?.summary ?? undefined
      }))
    };
    return response;
  });
}

async function safeHealth(
  check: () => Promise<boolean | undefined> | boolean | undefined
): Promise<ServiceHealthState> {
  try {
    const result = await check();
    return result === true ? "healthy" : result === false ? "unavailable" : "unknown";
  } catch {
    return "unavailable";
  }
}
