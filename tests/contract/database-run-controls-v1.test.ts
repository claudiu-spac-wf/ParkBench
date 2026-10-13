import assert from "node:assert/strict";
import test from "node:test";
import { databaseParameterOptions } from "../../packages/contracts/src/database-parameter-options";
import { resolveDatabaseRunControls } from "../../packages/contracts/src/database-run-controls";

import { runControlFixture } from "../helpers/run-controls";

test("P1 controls remain exposed alongside a scenario's restricted definitions", async () => {
  const { platform, document } = runControlFixture();
  try {
    await platform.startupRecovery;
    const definitions = platform.controlUi.getScenario(
      document.id,
      document.version
    )!.parameterDefinitions;
    for (const name of [
      "-bibufs",
      "database.apwCount",
      "database.biClusterSizeMiB",
      "database.biwEnabled"
    ])
      assert.ok(
        definitions.some((d) => d.canonicalName === name),
        name
      );
    const buffers = databaseParameterOptions({ version: "12.8.11" }).parameters.find(
      (p) => p.name === "-bibufs"
    )!;
    assert.equal(buffers.minimum, 3);
    assert.equal(buffers.maximum, undefined);
    assert.equal(buffers.multiUser.maximum.status,"not_specified");
  } finally {
    platform.close();
  }
});
test("scenario defaults yield to queued choices, narrow bounds hold, and legacy omission remains inherited", async () => {
  const { platform, document } = runControlFixture();
  try {
    await platform.startupRecovery;
    const custom = {
      ...document,
      version: "2.0.0",
      parameterDefinitions: [
        ...document.parameterDefinitions,
        {
          id: "apws",
          canonicalName: "database.apwCount",
          type: "integer",
          minimum: 0,
          maximum: 2,
          defaultValue: 2,
          description: "Scenario writers",
          source: "scenario",
          matrixAllowed: true,
          secret: false,
          definitionVersion: "1"
        },
        {
          id: "biw",
          canonicalName: "database.biwEnabled",
          type: "boolean",
          defaultValue: true,
          description: "Scenario writer",
          source: "scenario",
          matrixAllowed: true,
          secret: false,
          definitionVersion: "1"
        },
        {
          id: "cluster",
          canonicalName: "database.biClusterSizeMiB",
          type: "number",
          minimum: 0.015625,
          maximum: 16,
          step: 0.015625,
          defaultValue: 0.5,
          description: "Scenario cluster",
          source: "scenario",
          matrixAllowed: true,
          secret: false,
          definitionVersion: "1"
        }
      ]
    };
    platform.scenarios.register(custom);
    const request = {
      runName: "precedence",
      scenario: { id: custom.id, version: custom.version },
      dimensions: [],
      repetitions: 1
    };
    const inherited = platform.controlUi.preview(request).cells.items[0].databaseRunControls!;
    assert.equal(inherited.apwCount, 2);
    assert.equal(inherited.biwEnabled, true);
    assert.equal(inherited.sources.apwCount, "scenario");
    const chosen = platform.controlUi.preview({
      ...request,
      fixedOverrides: { "database.apwCount": 0, "database.biwEnabled": false }
    }).cells.items[0].databaseRunControls!;
    assert.equal(chosen.apwCount, 0);
    assert.equal(chosen.biwEnabled, false);
    assert.equal(chosen.sources.apwCount, "queued");
    assert.throws(
      () => platform.controlUi.preview({ ...request, fixedOverrides: { "database.apwCount": 3 } }),
      /bounds|maximum|range/
    );
    assert.throws(
      () =>
        platform.controlUi.preview({
          ...request,
          dimensions: [
            { name: "database.apwCount", values: [0, 1] },
            { name: "database.apwCount", values: [0, 1] }
          ]
        }),
      /duplicate_matrix_dimension/
    );
    const legacy = platform.controlUi.preview({
      ...request,
      scenario: { id: document.id, version: document.version }
    }).cells.items[0].databaseRunControls!;
    assert.equal(legacy.apwCount, 0);
    assert.equal(legacy.biwEnabled, false);
    assert.deepEqual(legacy.biCluster, { mode: "inherit" });
    assert.deepEqual(legacy.requested, {});
  } finally {
    platform.close();
  }
});

test("fixed and swept controls retain exact units, provenance and explicit false/zero", async () => {
  const { platform, document } = runControlFixture();
  try {
    await platform.startupRecovery;
    const request = {
      runName: "writer-sweep",
      scenario: { id: document.id, version: document.version },
      dimensions: [
        { name: "database.apwCount", values: [0, 2] },
        { name: "database.biwEnabled", values: [false, true] }
      ],
      fixedOverrides: { "-bibufs": 64, "database.biClusterSizeMiB": 16 },
      repetitions: 1
    };
    const preview = platform.controlUi.preview(request);
    assert.equal(preview.runCount, 4);
    for (const cell of preview.cells.items) {
      const c = cell.databaseRunControls as any;
      assert.equal(c.contractVersion, "db-run-controls.v1");
      assert.equal(c.apwCount, cell.values["database.apwCount"]);
      assert.equal(c.biwEnabled, cell.values["database.biwEnabled"]);
      assert.deepEqual(c.biCluster, { mode: "override", requestedMiB: 16, nativeKiB: 16384 });
      assert.equal(c.sources.apwCount, "queued");
      assert.equal(
        cell.databaseStartup?.parameters.find((p) => p.name === "-bibufs")?.displayValue,
        "64"
      );
    }
    assert.throws(
      () =>
        platform.controlUi.preview({
          ...request,
          fixedOverrides: { ...request.fixedOverrides, "database.apwCount": 2 }
        }),
      /conflict/
    );
  } finally {
    platform.close();
  }
});
test("direct scheduling resolves scenario controls once and preserves their source", async () => {
  const { platform, document } = runControlFixture();
  try {
    await platform.startupRecovery;
    const custom = {
      ...document,
      version: "2.0.0",
      parameterDefinitions: [
        ...document.parameterDefinitions,
        {
          id: "apw",
          canonicalName: "database.apwCount",
          type: "integer",
          minimum: 0,
          maximum: 9,
          defaultValue: 2,
          description: "Writers",
          source: "scenario",
          matrixAllowed: true,
          secret: false,
          definitionVersion: "1"
        },
        {
          id: "biw",
          canonicalName: "database.biwEnabled",
          type: "boolean",
          defaultValue: true,
          description: "BIW",
          source: "scenario",
          matrixAllowed: true,
          secret: false,
          definitionVersion: "1"
        }
      ]
    };
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: custom.id, version: custom.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [
          { id: "default", name: "Scenario default", parameters: {} },
          {
            id: "chosen",
            name: "Explicit disabled",
            parameters: { "database.apwCount": 0, "database.biwEnabled": false }
          }
        ],
        inputs: {
          databaseImage: `db:fixture@sha256:${"0123456789abcdef".repeat(4)}`,
          pasImage: `pas:fixture@sha256:${"abcdef0123456789".repeat(4)}`,
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      },
      custom
    );
    const [inherited, chosen] = experiment.runIds.map(
      (id) => platform.repositories.getRun(id)!.environmentSnapshot!.databaseRunControls as any
    );
    assert.equal(inherited.apwCount, 2);
    assert.equal(inherited.biwEnabled, true);
    assert.equal(inherited.sources.apwCount, "scenario");
    assert.equal(chosen.apwCount, 0);
    assert.equal(chosen.biwEnabled, false);
    assert.equal(chosen.sources.apwCount, "queued");
  } finally {
    platform.close();
  }
});

test("fresh direct scheduling freezes server-owned named requirements without mutating supplied legacy controls", async () => {
  const { platform, document } = runControlFixture();
  const legacy = resolveDatabaseRunControls();
  legacy.requirements = { namedLatchRequired: false, observerProtocolVersion: 4 };
  const original = structuredClone(legacy);
  try {
    await platform.startupRecovery;
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: document.id, version: document.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [
          {
            id: "legacy-supplied",
            name: "Legacy supplied",
            parameters: {},
            databaseRunControls: legacy
          }
        ],
        inputs: {
          databaseImage: "db:fixture",
          pasImage: "pas:fixture",
          seed: "input:seed",
          applicationArchive: "input:archive"
        }
      },
      document
    );
    const controls = platform.repositories.getRun(experiment.runIds[0])!.environmentSnapshot!
      .databaseRunControls as any;
    assert.deepEqual(controls.requirements, {
      namedLatchRequired: true,
      observerProtocolVersion: 4
    });
    assert.deepEqual(legacy, original);
  } finally {
    platform.close();
  }
});
