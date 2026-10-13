import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CatalogDiscoverySnapshot, OverviewSnapshot } from "../../packages/contracts/src";
import { createControlUiFixture } from "../fixtures/control-ui";

describe("catalog discovery and overview contracts", () => {
  it("keeps versioned schemas and nullable queue fields explicit", () => {
    const catalogSchema = JSON.parse(
      fs.readFileSync(
        path.resolve("packages/contracts/src/schemas/catalog-discovery-v1.schema.json"),
        "utf8"
      )
    );
    const overviewSchema = JSON.parse(
      fs.readFileSync(
        path.resolve("packages/contracts/src/schemas/overview-v1.schema.json"),
        "utf8"
      )
    );
    assert.equal(catalogSchema.$id, "parkbench/catalog-discovery.v1");
    assert.equal(overviewSchema.$id, "parkbench/overview.v1");
    const discovery: CatalogDiscoverySnapshot = {
      contractVersion: "catalog-discovery.v1",
      refreshState: "SUCCEEDED",
      categories: [],
      sources: []
    };
    const overview: OverviewSnapshot = {
      contractVersion: "overview.v1",
      health: {
        sqlite: "healthy",
        docker: "unknown",
        prometheus: "unavailable",
        checkedAt: new Date().toISOString()
      },
      discovery,
      queue: { activeExperiment: null, queued: 0, running: 0, blocked: 0, nextRetryAt: null },
      recentRuns: []
    };
    assert.equal(overview.queue.activeExperiment, null);
    assert.equal(overview.queue.nextRetryAt, null);
  });

  it("retires manual registration for every workload file", async () => {
    const fixture = await createControlUiFixture();
    const root = fs.mkdtempSync(path.join(process.cwd(), ".parkbench-workload-import-"));
    const invalidPath = path.join(root, "readme.txt");
    const validPath = path.join(root, "crud_cycle.p");
    fs.writeFileSync(invalidPath, "documentation");
    fs.writeFileSync(validPath, "procedure source");
    try {
      const invalid = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/catalog/assets/import",
        payload: { kind: "workload", name: "readme.txt", sourceRef: invalidPath }
      });
      assert.equal(invalid.statusCode, 410);

      const valid = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/catalog/assets/import",
        payload: { kind: "workload", name: "crud_cycle.p", sourceRef: validPath }
      });
      assert.equal(valid.statusCode, 410);
    } finally {
      await fixture.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
