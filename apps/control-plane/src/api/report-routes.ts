import { Platform } from "../platform";
import {
  REPORT_VERSION,
  terminalReport
} from "../../../../packages/contracts/src/database-analysis-report";
import { reportDefinitions } from "../../../../packages/contracts/src/database-analysis-definitions";
import { ReportQueries } from "../reports/queries";
import { reportDownload } from "../reports/downloads";
export function registerReportRoutes(app: any, platform: Platform) {
  const service = platform.reports,
    queries = new ReportQueries(service.repository);
  const route = (method: string, url: string, fn: (req: any, reply: any) => any) =>
    app[method]("/api/v1/reports" + url, async (req: any, reply: any) => {
      try {
        const result = { contractVersion: REPORT_VERSION, ...(await fn(req, reply)) };
        if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024)
          throw new Error("report_row_display_limit");
        return result;
      } catch (e) {
        const code = (e as Error).message;
        const status =
          code === "report_artifact_unavailable"
            ? 410
            : code.includes("not_found")
              ? 404
              : code.includes("conflict") ||
                  code === "report_artifact_invalid" ||
                  code === "report_revision_changed"
                ? 409
                : code.includes("version_unavailable")
                  ? 422
                  : 400;
        reply.code(status);
        return { error: { code, message: code.replace(/_/g, " "), fields: [] } };
      }
    });
  route("get", "/definitions", (r) =>
    reportDefinitions(r.query?.columnsVersion, r.query?.rulesVersion)
  );
  route("post", "", (r, reply) => {
    const report = service.create(r.body, r.headers["idempotency-key"]);
    reply.code(202);
    return { report };
  });
  route("get", "", (r) => queries.history(r.query));
  route("get", "/:id", (r) => ({ report: queries.require(r.params.id) }));
  route("post", "/:id/cancel", (r, reply) => {
    const report = service.cancel(r.params.id);
    reply.code(terminalReport(report.state) ? 200 : 202);
    return { report };
  });
  route("get", "/:id/summary", (r) => queries.summary(r.params.id));
  route("get", "/:id/datasets/:kind/rows", (r) =>
    queries.rows(r.params.id, r.params.kind, r.query)
  );
  route("get", "/:id/findings", (r) => queries.findings(r.params.id, r.query));
  app.get("/api/v1/reports/:id/artifacts/:artifactId", async (r: any, reply: any) => {
    try {
      const result = reportDownload(service.artifacts, r.params.id, r.params.artifactId);
      reply.type(result.artifact.mediaType);
      reply.header("Content-Disposition", `attachment; filename="${result.filename}"`);
      return reply.send(result.stream);
    } catch (e) {
      const code = (e as Error).message;
      reply.code(
        code.includes("not_found") ? 404 : code === "report_artifact_unavailable" ? 410 : 409
      );
      return { error: { code, message: code.replace(/_/g, " "), fields: [] } };
    }
  });
}
