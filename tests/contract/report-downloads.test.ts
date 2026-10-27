import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerReportRoutes } from "../../apps/control-plane/src/api/report-routes";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
test("stream CSV attachments retain full exact records regardless of result filters", async () => {
  const h = reportHarness(),
    app = Fastify();
  registerReportRoutes(app, { reports: h.service } as any);
  try {
    const r = h.service.create(request, "files");
    const done = await eventually(
      () => h.repo.get(r.id),
      (r) => r?.state === "COMPLETED"
    );
    const a = done.artifacts.find((a) => a.datasetKind === "table" && a.kind === "CSV"),
      url = `/api/v1/reports/${r.id}/artifacts/${a.id}`;
    const result = await app.inject({ url });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["content-type"], "text/csv; charset=utf-8");
    assert.match(
      String(result.headers["content-disposition"]),
      /attachment; filename="fixture-DBANALYS/
    );
    assert.ok(result.body.includes('"Size [bytes]"'));
    assert.ok(result.body.includes('"9007199254740993"'));
    await app.inject({ url: `/api/v1/reports/${r.id}/datasets/table/rows?search=absent` });
    assert.equal((await app.inject({ url })).body, result.body);
  } finally {
    await app.close();
    h.close();
  }
});
