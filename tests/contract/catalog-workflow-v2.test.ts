import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";

const fixture = path.resolve("tests/fixtures/simplify-run-workflow/scenarios/scenario-v2.json");

test("catalog reads only managed files, retires writes, and verifies all scenario paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-catalog-v2-"));
  const scenarios = path.join(root, "scenarios");
  fs.mkdirSync(scenarios);
  fs.copyFileSync(fixture, path.join(scenarios, "valid.json"));
  fs.writeFileSync(path.join(scenarios, "README.md"), "ignored");
  fs.writeFileSync(path.join(scenarios, "invalid.json"), "{");
  fs.mkdirSync(path.join(root, "workloads", "Sports2020"), { recursive: true });
  fs.writeFileSync(path.join(root, "workloads", "Sports2020", "crud_cycle.p"), "DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.\n");
  const platform = createPlatform({ host: "127.0.0.1", port: 0,
    dbPath: path.join(root, "parkbench.sqlite"), artifactRoot: path.join(root, "artifacts"),
    prometheusUrl: "http://127.0.0.1:9090", prometheusRetention: "7d",
    discoveryRoots: { scenarios, workloads: path.join(root, "workloads"),
      observers: path.join(root, "observers"), seeds: path.join(root, "seeds"),
      archives: path.join(root, "archives") },
    openedge: { dbImage: "db:test", pasImage: "pas:test", credentialRef: "credential:test" }
  } as any, { testMode: true });
  const server = buildServer(platform);
  try {
    await server.ready();
    const tableNames = (platform.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[])
      .map((row) => row.name);
    for (const removed of ["scenarios", "control_scenarios", "control_assets", "control_asset_discovery"])
      assert.equal(tableNames.includes(removed), false);
    const catalog = (await server.inject({ method: "GET", url: "/api/v1/catalog/assets?category=scenarios" })).json();
    assert.equal(catalog.items.length, 2);
    assert.deepEqual(catalog.items.map((item: any) => item.relativePath).sort(), ["invalid.json", "valid.json"]);
    assert.equal((await server.inject({ method: "POST", url: "/api/v1/catalog/assets/import", payload: {} })).statusCode, 410);
    assert.equal((await server.inject({ method: "POST", url: "/api/v1/scenarios", payload: {} })).statusCode, 410);
    const started = await server.inject({ method: "POST", url: "/api/v1/catalog/actions",
      payload: { kind: "VERIFY_SCENARIOS" } });
    assert.equal(started.statusCode, 202);
    const id = started.json().operationId;
    let action: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      action = (await server.inject({ method: "GET", url: `/api/v1/catalog/actions/${id}` })).json();
      if (["SUCCEEDED", "PARTIAL", "FAILED"].includes(action.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(action.state, "PARTIAL");
    assert.deepEqual(action.results.map((item: any) => item.state).sort(), ["FAILED", "PASSED"]);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
