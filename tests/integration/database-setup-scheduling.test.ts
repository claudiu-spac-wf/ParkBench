import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalMatrixRequest,
  expandMatrix
} from "../../packages/contracts/src/matrix-expansion";
import { builtinSetup, legacySchedule } from "../fixtures/database-setup/fixtures";
import { validateDatabaseSetup } from "../../packages/contracts/src/database-setup";

test("setup is static across two combinations and two repetitions, preserving repeated sets and identity", () => {
  const definition: any = {
    id: "b",
    canonicalName: "-B",
    type: "integer",
    minimum: 1,
    maximum: 10000,
    matrixAllowed: true,
    secret: false,
    source: "test",
    definitionVersion: "1"
  };
  const request: any = {
    ...legacySchedule,
    dimensions: [{ name: "-B", values: [100, 200] }],
    databaseSetup: validateDatabaseSetup(builtinSetup)
  };
  const cells: any[] = expandMatrix(request, [definition]);
  assert.equal(cells.length, 4);
  for (const cell of cells) assert.deepEqual(cell.databaseSetup, builtinSetup);
  cells[0].databaseSetup.steps[0].optionSets.reverse();
  assert.deepEqual(cells[1].databaseSetup, builtinSetup);
  assert.notEqual(
    canonicalMatrixRequest(request),
    canonicalMatrixRequest({
      ...request,
      databaseSetup: { ...request.databaseSetup, steps: [...request.databaseSetup.steps].reverse() }
    })
  );
  assert.equal(
    canonicalMatrixRequest(legacySchedule),
    canonicalMatrixRequest({
      ...legacySchedule,
      databaseSetup: { contractVersion: "database-setup.v1", steps: [] }
    } as any)
  );
});

import { createControlUiFixture } from "../fixtures/control-ui";
test("preview pages and frozen submit retain every ordered step/set without extra runs", async () => {
  const fixture = await createControlUiFixture();
  try {
    const scenarios = fixture.platform.controlUi.listScenarios();
    const source = (
      await fixture.app.inject({ method: "GET", url: "/api/v1/catalog/assets?category=scenarios" })
    ).json().items[0];
    const request: any = {
      ...legacySchedule,
      scenario: scenarios[0] ?? legacySchedule.scenario,
      scenarioSourceId: source?.id,
      dimensions: [{ name: "-B", values: [500, 1000] }],
      databaseSetup: validateDatabaseSetup(structuredClone(builtinSetup)),
      inputs: { seed: "input:seed", applicationArchive: "input:archive" }
    };
    const preview = fixture.platform.controlUi.preview(request, undefined, 1);
    assert.equal(preview.runCount, 4);
    const items = [...preview.cells.items];
    let token = preview.cells.nextPageToken;
    while (token) {
      const page = fixture.platform.controlUi.previewCells(preview.previewId, token, 1);
      items.push(...page.cells.items);
      token = page.cells.nextPageToken;
    }
    for (const cell of items) assert.deepEqual(cell.databaseSetup, builtinSetup);
    request.databaseSetup.steps.reverse();
    const result = fixture.platform.controlUi.submit({
      previewId: preview.previewId,
      confirm: true
    });
    assert.equal(result.runs.length, 4);
    for (const run of result.runs) {
      const stored = fixture.platform.repositories.getRun(run.id)!;
      assert.deepEqual(stored.environmentSnapshot?.databaseSetup, builtinSetup);
    }
    const options = (await fixture.app.inject({ method: "GET", url: "/api/v1/ui-options" })).json();
    assert.equal(options.databaseSetup.length, 3);
    const old = result.runs[0];
    const status = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/runs/${old.id}/database-setup`
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().state, "PENDING");
    assert.equal(
      (await fixture.app.inject({ method: "GET", url: "/api/v1/runs/absent/database-setup" }))
        .statusCode,
      404
    );
  } finally {
    await fixture.close();
  }
});
