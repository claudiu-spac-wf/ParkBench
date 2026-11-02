import { discoverSetupScripts } from "../database-setup/scripts";
import { Platform } from "../platform";
import { currentSetupEvidence } from "../database-setup/evidence";
export function registerDatabaseSetupRoutes(app: any, platform: Platform) {
  app.get("/api/v1/database-setup/scripts", async () =>
    discoverSetupScripts(platform.config.discoveryRoots?.scripts)
  );
  app.get("/api/v1/runs/:runId/database-setup", async (request: any, reply: any) => {
    const run = platform.repositories.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ code: "run_not_found" });
    return {
      ...currentSetupEvidence(run),
      configuration: run.environmentSnapshot?.databaseSetup ?? null,
      artifacts: platform.repositories
        .listArtifacts(run.id)
        .filter((a) => a.sourceMetadata?.databaseSetup)
        .map((a) => ({ id: a.id, path: a.path, url: `/api/v1/runs/${run.id}/artifacts/${a.id}` }))
    };
  });
}
