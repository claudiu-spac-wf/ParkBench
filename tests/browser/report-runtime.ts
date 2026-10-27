import Fastify from "fastify";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { registerReportRoutes } from "../../apps/control-plane/src/api/report-routes";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
import { tenThousandTables } from "../fixtures/reports/fixtures";
/** Actual SQLite projection/API behind the browser; native execution alone uses a fake. */
export async function reportRuntime(page: any, large = false, configure?: (h: any) => void) {
  const h = reportHarness();
  const original = h.runner.execute.bind(h.runner);
  if (large)
    h.runner.execute = async (...a: any[]) => {
      const result = await original(a[0], a[1], a[2]);
      fs.writeFileSync(path.join(a[1].directory, "raw", "report.tab.txt"), tenThousandTables());
      return result;
    };
  configure?.(h);
  const created = h.service.create(
      { ...request, type: large ? "TABANALYS" : "DBANALYS" },
      "browser"
    ),
    report = await eventually(
      () => h.repo.get(created.id),
      (r) => r?.state === "COMPLETED",
      60000
    );
  const app = Fastify();
  registerReportRoutes(app, { reports: h.service } as any);
  app.get("/*", async (request, reply) => {
    const response = await fetch(
      (process.env.PARKBENCH_REPORT_TEST_ASSET_URL ?? "http://127.0.0.1:4173") + request.url
    );
    reply
      .code(response.status)
      .type(response.headers.get("content-type") ?? "application/octet-stream");
    return reply.send(Readable.fromWeb(response.body as any));
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    h,
    address,
    app,
    report,
    async close() {
      try {
        if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
      } finally {
        await app.close();
        h.close();
      }
    }
  };
}
