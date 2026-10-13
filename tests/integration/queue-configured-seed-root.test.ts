import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { createSeedFixture } from "../helpers/seed";
import scenario from "../../examples/scenarios/crud-rest.json";
import { validateExperimentRequest } from "../../packages/compose-runner/src/preflight";

test("interactive queue preflight accepts a seed in the configured external discovery root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-queue-seeds-"));
  const seed = createSeedFixture(path.join(root, "seeds"));
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: path.join(root, "artifacts"),
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {},
      discoveryRoots: {
        scenarios: path.resolve("examples/scenarios"),
        seeds: path.join(root, "seeds"),
        archives: path.join(root, "archives"),
        workloads: path.resolve("openedge/workloads/Workloads"),
        observers: path.join(root, "observers")
      }
    },
    { testMode: true, phaseScale: 0 }
  );
  let runId: string | undefined;
  let executionFinished = false;
  const unsubscribe = platform.coordinator.onExperimentFinished(() => {
    executionFinished = true;
  });
  try {
    await platform.startupRecovery;
    platform.scenarios.register(scenario as any);
    const preview = platform.controlUi.preview({
      runName: "external-seed",
      scenario: { id: scenario.id, version: scenario.version },
      dimensions: [],
      repetitions: 1,
      inputs: { seed }
    });
    const queued = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
    runId = queued.runs[0].id;
    const started = await platform.controlUi.startQueue();
    assert.equal(
      started.started,
      queued.id,
      JSON.stringify(started.queued.map((r) => ({ state: r.state, reason: r.blockedReason })))
    );
    const foreign = createSeedFixture(path.join(root, "unconfigured-seeds"));
    assert.throws(
      () =>
        validateExperimentRequest(
          {
            scenario: { id: scenario.id, version: scenario.version },
            comparisonMode: "exploratory",
            repetitions: 1,
            variants: [{ id: "foreign", name: "Foreign", parameters: {} }],
            inputs: {
              databaseImage: "openedge-db:fixture",
              pasImage: "openedge-pas:fixture",
              seed: foreign,
              applicationArchive: "input:archive",
              credentialRef: "credential:fixture"
            }
          },
          scenario as any,
          {
            inputRoot: process.cwd(),
            seedsRoot: path.join(root, "seeds"),
            diskIo: { cadvisor: true, nodeExporterBlockDevice: true }
          }
        ),
      /seed_outside_allowed_root/
    );
  } finally {
    if (runId) {
      const run = platform.repositories.getRun(runId)!;
      if (!["SUCCEEDED", "FAILED", "CANCELLED", "INCOMPLETE"].includes(run.state))
        platform.coordinator.cancel(runId);
      const deadline = Date.now() + 3000;
      while (!executionFinished && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(executionFinished, true, "owned experiment must finish before closing storage");
    }
    unsubscribe();
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
