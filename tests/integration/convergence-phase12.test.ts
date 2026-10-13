import { describe, it } from "node:test";
import assert from "node:assert/strict";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import { ValidationError } from "../../packages/contracts/src";
import {
  validateRequiredMeasurements,
  validateParameterDefinitions
} from "../../apps/control-plane/src/catalog/scenario-validation";

function createTestPlatform() {
  return createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: ".parkbench/test-convergence-phase12",
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {}
    },
    { testMode: true }
  );
}

function validRun(platform: ReturnType<typeof createTestPlatform>, runId: string, complete = true) {
  const run = platform.repositories.getRun(runId)!;
  run.state = "SUCCEEDED";
  run.measurementValidity = complete ? "VALID" : "INCOMPLETE";
  run.cleanupStatus = "COMPLETE";
  run.completeness = {
    complete,
    requiredGaps: complete
      ? []
      : [{ observerId: "db", phase: "measurement", expected: 2, observed: 1, missing: 1 }],
    optionalWarnings: []
  };
  platform.repositories.saveRun(run);
  return run;
}

function createExperiment(platform: ReturnType<typeof createTestPlatform>, dimension = "-B") {
  const preview = platform.controlUi.preview({
    runName: "test-run",
    scenario: { id: "crud-rest", version: "1.0.0" },
    dimensions: [{ name: dimension, values: [500, 1000] }],
    repetitions: 1
  });
  return platform.controlUi.submit({
    previewId: preview.previewId,
    confirm: true
  });
}

describe("phase 12 convergence boundaries", () => {
  it("allows cross-experiment comparison and keeps incomplete measurement status visible", async () => {
    const platform = createTestPlatform();
    let closed = false;
    try {
      await platform.startupRecovery;
      platform.scenarios.register(scenario);
      platform.controlUi.syncExistingScenarios();
      const first = createExperiment(platform);
      const second = createExperiment(platform, "-B");
      validRun(platform, first.runs[0].id);
      validRun(platform, second.runs[0].id);
      const mixed = platform.controlUi.createComparison({
        experimentId: first.id,
        baselineRunId: first.runs[0].id,
        variantRunIds: [second.runs[0].id]
      });
      assert.deepEqual(mixed.selectionPage.runIds, [first.runs[0].id, second.runs[0].id]);
      assert.equal(mixed.experimentId, undefined);
      assert.deepEqual(mixed.warnings, []);
      const dashboard = platform.controlUi.getDashboard(mixed.dashboardContextId)!;
      assert.deepEqual(dashboard.runIds, mixed.selectionPage.runIds);
      assert.deepEqual(new Set(dashboard.variables.experiment_id), new Set([first.id, second.id]));
      validRun(platform, first.runs[1].id, false);
      const comparison = platform.controlUi.createComparison({
        experimentId: first.id,
        baselineRunId: first.runs[0].id,
        variantRunIds: [first.runs[1].id]
      });
      assert.equal(comparison.contractVersion, "comparison.v2");
      assert.equal(comparison.runs[1].measurementValidity, "INCOMPLETE");
      assert.deepEqual(comparison.warnings, []);
      const foreign = platform.repositories.getRun(second.runs[0].id)!;
      foreign.state = "FAILED";
      foreign.measurementValidity = "INCOMPLETE";
      foreign.environmentSnapshot = { scenario: { id: "another-scenario", version: "2" } };
      platform.repositories.saveRun(foreign);
      const app = buildServer(platform);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/comparisons",
          payload: {
            baselineRunId: first.runs[0].id,
            variantRunIds: [foreign.id, first.runs[1].id, foreign.id]
          }
        });
        assert.equal(response.statusCode, 201);
        const saved = response.json();
        assert.deepEqual(saved.selectionPage.runIds, [
          first.runs[0].id,
          foreign.id,
          first.runs[1].id
        ]);
        assert.deepEqual(
          saved.warnings.map((w) => w.code),
          ["different_scenarios"]
        );
        const reread = (
          await app.inject({ method: "GET", url: `/api/v1/comparisons/${saved.id}?limit=1` })
        ).json();
        assert.equal(reread.runs.length, 1);
        assert.deepEqual(reread.warnings, saved.warnings);
        assert.deepEqual(platform.controlUi.resolveComparisonSelection(saved.id)?.variantRunIds, [
          foreign.id,
          first.runs[1].id
        ]);
        assert.throws(
          () =>
            platform.controlUi.createComparison({
              baselineRunId: foreign.id,
              variantRunIds: [],
              authorizedRunIds: [first.runs[0].id]
            }),
          /not_authorized/
        );
        assert.throws(
          () => platform.controlUi.createComparison({ variantRunIds: ["unknown-run"] }),
          /not_found/
        );
      } finally {
        await app.close();
        closed = true;
      }
    } finally {
      if (!closed) platform.close();
    }
  });

  it("requires complete paginated matrix review before the client can confirm", async () => {
    const platform = createTestPlatform();
    try {
      await platform.startupRecovery;
      platform.scenarios.register(scenario);
      platform.controlUi.syncExistingScenarios();
      const first = platform.controlUi.preview(
        {
          runName: "test-run",
          scenario: { id: "crud-rest", version: "1.0.0" },
          dimensions: [{ name: "-B", values: [500, 1000] }],
          repetitions: 1
        },
        undefined,
        1
      );
      assert.equal(first.review.complete, false);
      assert.throws(
        () =>
          platform.controlUi.submit({
            previewId: first.previewId,
            confirm: true
          }),
        /matrix_review_incomplete/
      );
      const finalPage = platform.controlUi.previewCells(
        first.previewId,
        first.cells.nextPageToken,
        1
      );
      assert.equal(finalPage.review.complete, true);
      assert.equal(finalPage.review.loadedRunCount, 2);
    } finally {
      platform.close();
    }
  });

  it("validates required measurements and parameter constraints without saving scenarios", async () => {
    const platform = createTestPlatform();
    try {
      await platform.startupRecovery;
      const invalid = {
        ...scenario,
        version: "1.0.1",
        requiredMeasurements: [
          { id: "db", metricName: "missing_metric", source: "observer", observerId: "core" }
        ]
      } as any;
      assert.doesNotThrow(() => validateRequiredMeasurements(invalid));
      invalid.requiredMeasurements[0].observerId = "missing";
      assert.throws(
        () => validateRequiredMeasurements(invalid),
        (error: unknown) =>
          error instanceof ValidationError && error.fields[0].path.includes("requiredMeasurements")
      );
      assert.equal(platform.controlUi.getScenario("crud-rest", "1.0.1"), undefined);
      const definitions = [
        {
          id: "param_B",
          canonicalName: "-B",
          type: "integer",
          minimum: 10,
          maximum: 5000,
          defaultValue: 500,
          description: "Buffer",
          source: "operator",
          matrixAllowed: true,
          secret: false,
          definitionVersion: "1"
        }
      ] as any;
      assert.doesNotThrow(() => validateParameterDefinitions(definitions));
      assert.equal(definitions[0].allowedValues, undefined);
      assert.equal(definitions[0].dependencies, undefined);
      assert.throws(() => platform.controlUi.saveScenario(scenario), /operation_retired/);
    } finally {
      platform.close();
    }
  });

  it("exposes a run-scoped dashboard and terminal evidence links", async () => {
    const platform = createTestPlatform();
    try {
      await platform.startupRecovery;
      platform.scenarios.register(scenario);
      platform.controlUi.syncExistingScenarios();
      const experiment = createExperiment(platform);
      const run = validRun(platform, experiment.runs[0].id);
      const detail = await platform.controlUi.runDetail(run.id);
      assert.equal((detail?.comparisonEligibility as any).eligible, true);
      assert.equal((detail?.dashboardContext as any).runIds[0], run.id);
      assert.ok(
        (detail?.evidence as any).links.some((link: any) => link.label === "artifact index")
      );
    } finally {
      platform.close();
    }
  });

  it("rejects registration of all catalog asset types", async () => {
    const platform = createTestPlatform();
    const app = buildServer(platform);
    try {
      await platform.startupRecovery;
      const response: any = await app.inject({
        method: "POST",
        url: "/api/v1/catalog/assets/import",
        payload: {
          kind: "workload",
          name: "managed-workload.p",
          sourceRef: "input:workload/managed-workload.p"
        }
      });
      assert.equal(response.statusCode, 410);
      assert.match(response.body, /operation_retired/);
      const rejected: any = await app.inject({
        method: "POST",
        url: "/api/v1/catalog/assets/import",
        payload: {
          kind: "workload",
          name: "unsafe.p",
          sourceRef: "input:workload/unsafe.p",
          content: "private"
        }
      });
      assert.equal(rejected.statusCode, 410);
    } finally {
      await app.close();
    }
  });
});
