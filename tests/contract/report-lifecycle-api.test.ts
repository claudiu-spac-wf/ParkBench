import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fs from "node:fs";
import { registerReportRoutes } from "../../apps/control-plane/src/api/report-routes";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
test("strict lifecycle API, idempotent replay after seed removal, terminal cancel and separate reruns", async () => {
  const h = reportHarness(),
    app = Fastify();
  registerReportRoutes(app, { reports: h.service } as any);
  try {
    h.gate.pause();
    const send = (body: any, key?: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/reports",
        headers: key ? { "idempotency-key": key } : {},
        payload: body
      });
    assert.equal((await send(request)).statusCode, 400);
    assert.equal((await send({ ...request, timeout: 1 }, "bad")).statusCode, 400);
    const accepted = await send(request, "same");
    assert.equal(accepted.statusCode, 202);
    const id = accepted.json().report.id;
    h.service.options.resolveSeed = () => {
      throw new Error("report_seed_unavailable");
    };
    assert.equal((await send(request, "same")).json().report.id, id);
    assert.equal((await send({ ...request, type: "IDXANALYS" }, "same")).statusCode, 409);
    const cancelled = await app.inject({ method: "POST", url: `/api/v1/reports/${id}/cancel` });
    assert.equal(cancelled.json().report.state, "CANCELLED");
    assert.equal(
      (await app.inject({ method: "POST", url: `/api/v1/reports/${id}/cancel` })).statusCode,
      200
    );
    const history = await app.inject({ url: "/api/v1/reports?state=CANCELLED" });
    assert.equal(history.json().items.length, 1);
    assert.equal(
      (await app.inject({ url: "/api/v1/reports/definitions?rulesVersion=unknown" })).statusCode,
      422
    );
    assert.equal((await app.inject({ url: "/api/v1/reports/absent" })).statusCode, 404);
  } finally {
    await app.close();
    h.close();
  }
});
import { ReportQueries } from "../../apps/control-plane/src/reports/queries";
test("history paginates captured identities and binds cursors to filters", () => {
  const h = reportHarness();
  try {
    h.gate.pause();
    const reports = Array.from({ length: 5 }, (_, i) => h.service.create(request, String(i)));
    const q = new ReportQueries(h.repo),
      first = q.history({ limit: "2" });
    assert.equal(first.items.length, 2);
    assert.equal(first.items[0].id, reports[4].id);
    const second = q.history({ limit: "2", cursor: first.nextCursor });
    assert.equal(second.items[0].id, reports[2].id);
    assert.throws(() => q.history({ state: "FAILED", cursor: first.nextCursor }), /cursor_invalid/);
  } finally {
    h.close();
  }
});
