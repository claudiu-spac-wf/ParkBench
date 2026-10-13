import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../packages/contracts/src/config";
import { createControlUiFixture } from "../fixtures/control-ui";
import scenario from "../../examples/scenarios/crud-rest.json";

for (const enabled of [false, true]) {
  test(`configured Enterprise capability ${enabled ? "permits" : "explains why it blocks"} writer previews`, async () => {
    const config = loadConfig({
      PARKBENCH_OPENEDGE_VERSION: "12.8.11",
      PARKBENCH_OPENEDGE_DB_FEATURES: enabled ? " enterprise " : ""
    });
    const fixture = await createControlUiFixture({
      databaseCapabilities: {
        version: config.openedge.version,
        features: config.openedge.databaseFeatures
      }
    });
    try {
      const options = await fixture.app.inject({ method: "GET", url: "/api/v1/ui-options" });
      assert.deepEqual(options.json().databaseParameters.features, enabled ? ["enterprise"] : []);
      const preview = async (apwCount: number, biwEnabled: boolean) =>
        fixture.app.inject({
          method: "POST",
          url: "/api/v1/experiments/preview",
          payload: {
            runName: "writer-capability",
            scenario: { id: scenario.id, version: scenario.version },
            dimensions: [],
            repetitions: 1,
            fixedOverrides: { "database.apwCount": apwCount, "database.biwEnabled": biwEnabled }
          }
        });
      for (const [apwCount, biwEnabled] of [
        [2, false],
        [0, true]
      ] as const) {
        const response = await preview(apwCount, biwEnabled);
        if (enabled) {
          assert.equal(response.statusCode, 200, response.body);
          const controls = response.json().cells.items[0].databaseRunControls;
          assert.equal(controls.apwCount, apwCount);
          assert.equal(controls.biwEnabled, biwEnabled);
          assert.deepEqual(controls.capabilityReference.features, ["enterprise"]);
          assert.equal(controls.capabilityReference.verification, "pending_native");
        } else {
          assert.equal(response.statusCode, 422);
          assert.match(
            response.json().error.message,
            /database_writer_unavailable:enterprise_required/
          );
          assert.match(response.json().error.message, /capability is not configured/);
          assert.match(response.json().error.message, /PARKBENCH_OPENEDGE_DB_FEATURES=enterprise/);
          assert.match(response.json().error.message, /restart the control plane/);
        }
      }
      const noWriters = await preview(0, false);
      assert.equal(noWriters.statusCode, 200, noWriters.body);
      assert.equal(
        fixture.platform.repositories.listExperiments().length,
        0,
        "preview does not provision runs"
      );
    } finally {
      await fixture.close();
    }
  });
}
