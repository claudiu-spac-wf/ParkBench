import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { buildServer } from "../../apps/control-plane/src/server";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { ManagedRootFileDiscovery } from "../../apps/control-plane/src/catalog/file-discovery";

describe("disk-backed catalog discovery API", () => {
  it("lists 101 JSON paths, ignores other extensions, and keeps duplicate IDs path-selectable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-discovery-scale-"));
    const scenarioRoot = path.join(root, "scenarios");
    fs.mkdirSync(scenarioRoot);
    for (let index = 0; index < 100; index++) {
      const id = index < 2 ? "same-id" : `scenario-${index}`;
      fs.writeFileSync(path.join(scenarioRoot, `${index}.json`), JSON.stringify({ ...scenario, id }));
    }
    fs.writeFileSync(path.join(scenarioRoot, "broken.json"), "{");
    for (let index = 0; index < 5; index++)
      fs.writeFileSync(path.join(scenarioRoot, `README-${index}.md`), "ignored");
    const platform = createPlatform({ host: "127.0.0.1", port: 0, dbPath: ":memory:",
      artifactRoot: path.join(root, "artifacts"), prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d", discoveryRoots: { scenarios: scenarioRoot }, openedge: {} } as any,
    { testMode: true });
    const app = buildServer(platform);
    try {
      await app.ready();
      const response = await app.inject({ method: "GET", url: "/api/v1/catalog/assets?category=scenarios&pageSize=250" });
      assert.equal(response.statusCode, 200);
      const entries = response.json().items as Array<any>;
      assert.equal(entries.length, 101);
      assert.equal(entries.filter((item) => item.relativePath.endsWith(".md")).length, 0);
      assert.equal(entries.filter((item) => item.sourceStatus === "INVALID").length, 1);
      const duplicates = entries.filter((item) => item.declaredScenarioId === "same-id");
      assert.equal(duplicates.length, 2);
      assert.ok(duplicates.every((item) => item.failureReasons.some((reason: string) => reason.startsWith("scenario_id_conflict:"))));
      const declared = await app.inject({ method: "GET", url: "/api/v1/scenarios/same-id/1.0.0" });
      assert.equal(declared.statusCode, 409);
      assert.match(declared.body, /0\.json/);
      assert.match(declared.body, /1\.json/);
      for (const [index, entry] of duplicates.entries())
        assert.equal(platform.controlUi.preview({ contractVersion: "experiment-schedule.v2",
          runName: `Duplicate ${index}`, scenarioSourceId: entry.id,
          dimensions: [{ name: "-B", values: [500] }], repetitions: 1,
          inputs: { seed: "input:seed", applicationArchive: "input:archive" } }).runCount, 1);
    } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("shows each JSON scenario once, excludes other files and Docker, and follows disk changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-discovery-api-"));
    const scenarioRoot = path.join(root, "scenarios");
    fs.mkdirSync(scenarioRoot);
    fs.writeFileSync(path.join(scenarioRoot, "crud-rest.json"), JSON.stringify(scenario));
    fs.writeFileSync(path.join(scenarioRoot, "README.md"), "not a scenario");
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: path.join(root, "artifacts"),
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        discoveryRoots: { scenarios: scenarioRoot },
        openedge: {}
      } as any,
      {
        testMode: true,
        discoveryProviders: {
          docker: {
            listLocalImages: async () => {
              throw new Error("unused Docker source");
            }
          } as any,
          filesystem: new ManagedRootFileDiscovery({ scenarios: scenarioRoot })
        }
      }
    );
    const app = buildServer(platform);
    try {
      await app.ready();
      const discovery = (
        await app.inject({ method: "GET", url: "/api/v1/catalog/discovery" })
      ).json();
      assert.equal(discovery.refreshState, "SUCCEEDED");
      assert.equal(discovery.categories.length, 5);
      assert.equal(
        discovery.categories.some((item: any) => item.key === "docker_images"),
        false
      );
      assert.equal(
        discovery.categories.some((item: any) => item.key === "configs"),
        false
      );
      const list = async () =>
        (
          await app.inject({ method: "GET", url: "/api/v1/catalog/assets?category=scenarios" })
        ).json().items;
      assert.equal((await list()).length, 1);
      fs.rmSync(path.join(scenarioRoot, "crud-rest.json"));
      assert.equal((await list()).length, 0);
      assert.equal(
        platform.database.db
          .prepare("SELECT name FROM sqlite_master WHERE name='control_asset_discovery'")
          .get(),
        undefined
      );
      const overview = await app.inject({ method: "GET", url: "/api/v1/overview" });
      assert.equal(overview.statusCode, 200);
      assert.ok(overview.json().health.sqlite);
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("isolates a missing workload root while retaining scenarios", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-discovery-failure-"));
    const scenarioRoot = path.join(root, "scenarios");
    fs.mkdirSync(scenarioRoot);
    fs.writeFileSync(path.join(scenarioRoot, "fixture.json"), JSON.stringify(scenario));
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: path.join(root, "artifacts"),
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        discoveryRoots: { scenarios: scenarioRoot },
        openedge: {}
      } as any,
      {
        testMode: true,
        discoveryProviders: {
          docker: {} as any,
          filesystem: new ManagedRootFileDiscovery({
            scenarios: scenarioRoot,
            workloads: path.join(root, "missing")
          })
        }
      }
    );
    const app = buildServer(platform);
    try {
      await app.ready();
      const snapshot = (
        await app.inject({ method: "GET", url: "/api/v1/catalog/discovery" })
      ).json();
      assert.equal(snapshot.categories.find((item: any) => item.key === "scenarios").count, 1);
      assert.equal(
        snapshot.categories.find((item: any) => item.key === "workloads").sourceState,
        "EMPTY"
      );
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
