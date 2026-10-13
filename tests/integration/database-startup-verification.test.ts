import { savedRun } from "../helpers/saved-run";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import type { OpenEdgeDbParameterCapture } from "../../packages/contracts/src/openedge-db-parameter-capture";

const startup = {
  contractVersion: "db-startup-parameters.v1" as const,
  databaseName: "parkbench",
  startupFile: { status: "absent" as const },
  parameters: [
    {
      name: "-B",
      displayValue: "1000",
      source: "queued" as const,
      overrides: [],
      applicability: "database_broker" as const,
      verification: "pending" as const
    }
  ]
};
const images = {
  databaseImage: `db:fixture@sha256:${"0123456789abcdef".repeat(4)}`,
  pasImage: `pas:fixture@sha256:${"abcdef0123456789".repeat(4)}`,
  seed: "input:seed/fixture",
  applicationArchive: "input:archive/fixture"
};
const native = (rows: OpenEdgeDbParameterCapture["rows"]): OpenEdgeDbParameterCapture => ({
  contractVersion: "openedge-db-parameter-capture.v1",
  databaseName: "parkbench",
  attemptedAt: "2026-09-28T10:00:00.000Z",
  capturedAt: "2026-09-28T10:00:00.000Z",
  source: "_DbParams",
  status: "complete",
  rows
});

for (const [name, response, code, snapshotExpected] of [
  [
    "matched",
    native([{ name: "-B", rawValue: "1000", dtype: 4, isDefault: false }]),
    undefined,
    true
  ],
  [
    "ignored override",
    native([{ name: "-B", rawValue: "500", dtype: 4, isDefault: false }]),
    "database_parameter_unapplied",
    true
  ],
  ["missing reading", native([]), "database_parameter_unverifiable", true],
  [
    "incompatible response",
    { ...native([]), contractVersion: "future" },
    "database_parameter_capture_invalid",
    false
  ]
] as const) {
  test(`startup verification ${name} occurs before workload`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-startup-verification-"));
    const orchestrator = new FakeRunOrchestrator();
    const prometheus = new MemoryPrometheusClient();
    let captures = 0;
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: root,
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      {
        testMode: true,
        orchestrator,
        prometheus,
        phaseScale: 0,
        parameterCapture: async () => {
          captures++;
          return response as OpenEdgeDbParameterCapture;
        }
      }
    );
    try {
      const experiment = platform.coordinator.createExperiment(
        {
          scenario: { id: scenario.id, version: scenario.version },
          comparisonMode: "exploratory",
          repetitions: 1,
          variants: [
            { id: "v1", name: "Variant", parameters: { "-B": 1000 }, databaseStartup: startup }
          ],
          inputs: images
        },
        scenario as any
      );
      const run = await platform.coordinator.executeRun(
        platform.repositories.getRun(experiment.runIds[0])!
      );
      assert.equal(captures, 1);
      assert.equal(run.failureCode, code);
      assert.equal(orchestrator.calls.includes("start-workload"), code === undefined);
      const snapshotPath = path.join(root, run.id, "db-parameter-snapshot.json");
      assert.equal(fs.existsSync(snapshotPath), snapshotExpected);
      const { context, summary } = savedRun(root, platform.repositories, run.id);
      assert.equal(
        context.parameterReference.state,
        snapshotExpected ? "captured" : "not_captured"
      );
      if (snapshotExpected) {
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
        assert.equal(
          snapshot.verificationResults[0].verification,
          code === undefined
            ? "matched"
            : code === "database_parameter_unapplied"
              ? "mismatched"
              : "unverifiable"
        );
        assert.equal(
          snapshot.verificationResults[0].observedValue,
          code === "database_parameter_unverifiable"
            ? null
            : code === "database_parameter_unapplied"
              ? "500"
              : "1000"
        );
        assert.equal(
          context.effective.databaseStartup.parameters[0].verification,
          snapshot.verificationResults[0].verification
        );
        // Run series stay in Prometheus; the evidence records where (no manifest.json export).
        assert.equal(fs.existsSync(path.join(root, run.id, "manifest.json")), false);
        assert.ok(summary.metricsReference.source);
        if (code) assert.equal(summary.windows.measurement.state, "not_started");
      } else assert.equal(context.parameterReference.reasonCode, "observer_response_invalid");
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("direct experiment broker values are verified without a databaseStartup object", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-direct-startup-verification-"));
  const orchestrator = new FakeRunOrchestrator();
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {}
    },
    {
      testMode: true,
      orchestrator,
      phaseScale: 0,
      parameterCapture: async () =>
        native([{ name: "-B", rawValue: "500", dtype: 4, isDefault: false }])
    }
  );
  try {
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "direct", name: "Direct", parameters: { "-B": 1000 } }],
        inputs: images
      },
      scenario as any
    );
    const queued = platform.repositories.getRun(experiment.runIds[0])!;
    assert.equal(
      (queued.environmentSnapshot as any).databaseStartup.parameters[0].displayValue,
      "1000"
    );
    const run = await platform.coordinator.executeRun(queued);
    assert.equal(run.failureCode, "database_parameter_unapplied");
    assert.equal(orchestrator.calls.includes("start-workload"), false);
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(root, run.id, "db-parameter-snapshot.json"), "utf8")
    );
    assert.equal(snapshot.verificationResults[0].verification, "mismatched");
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
