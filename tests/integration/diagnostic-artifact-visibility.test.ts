import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { actionFixture } from "../fixtures/experiment-actions";
import { buildServer } from "../../apps/control-plane/src/server";
import { ReportQueries } from "../../apps/control-plane/src/reports/queries";

test("all run artifact listings hide diagnostics while files and internal cleanup inventory retain them", async () => {
  const f = await actionFixture(),
    app = buildServer(f.platform);
  try {
    f.terminal();
    const id = f.runIds[0];
    const hidden = f.platform.artifacts.write(
      id,
      "diagnostics",
      "hidden-investigation.json",
      '{"diagnostic":true}',
      "json",
      { databaseSetup: true }
    );
    const visible = f.platform.artifacts.write(id, "load_summary", "visible-summary.json", "{}");
    const routes = [
      `/api/v1/runs/${id}/artifacts`,
      `/api/v1/runs/${id}`,
      `/api/v1/history/runs/${id}`,
      `/api/v1/runs/${id}/database-setup`
    ];
    for (const url of routes) {
      const r = await app.inject({ method: "GET", url });
      assert.equal(r.statusCode, 200, url);
      assert.ok(!r.body.includes(hidden.id), url);
      if (url.endsWith("/artifacts")) assert.ok(r.body.includes(visible.id));
    }
    const operator = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${id}/artifacts?includeDiagnostics=true`
    });
    assert.equal(operator.statusCode, 200);
    assert.ok(operator.body.includes(hidden.id));
    assert.ok(f.platform.repositories.listArtifacts(id).some((a) => a.id === hidden.id));
    assert.ok(fs.existsSync(f.platform.storage.safePath(hidden.path)));
  } finally {
    await app.close();
    f.close();
  }
});

test("report read projections hide DIAGNOSTIC files without changing retained source records", () => {
  const report = {
    id: "report",
    artifacts: [
      { id: "hidden", kind: "DIAGNOSTIC" },
      { id: "source", kind: "SOURCE" },
      { id: "csv", kind: "CSV" }
    ]
  };
  const queries = new ReportQueries({ get: () => report } as any);
  assert.deepEqual(
    queries.require(report.id).artifacts.map((a) => a.id),
    ["source", "csv"]
  );
  assert.equal(report.artifacts.length, 3);
});
