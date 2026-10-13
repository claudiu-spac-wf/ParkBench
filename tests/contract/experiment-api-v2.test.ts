import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMatrix } from "../../apps/control-plane/src/experiments/matrix";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { ScenarioFileSource } from "../../apps/control-plane/src/catalog/scenario-source";

describe("experiment-api-v2 submission contract", () => {
  it("permits comparative submission without a baseline selection", () => {
    assert.doesNotThrow(() =>
      validateMatrix({
        scenario: { id: "crud-rest", version: "1.0.0" },
        comparisonMode: "comparative",
        repetitions: 1,
        variants: [{ id: "cell-0", name: "Cell 0", parameters: {} }],
        inputs: {} as any
      })
    );
  });
});

describe("experiment-schedule.v2 disk source and configured inputs", () => {
  it("previews either path when two files declare the same ID and rejects image overrides", async () => {
    const scenariosRoot = path.resolve("tests/fixtures/simplify-run-workflow/scenarios");
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-schedule-v2",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        discoveryRoots: { scenarios: scenariosRoot },
        openedge: {
          dbImage: "parkbench/openedge-db:fixture",
          pasImage: "parkbench/openedge-pas:fixture",
          credentialRef: "credential:pas-metrics-fixture"
        }
      } as any,
      { testMode: true }
    );
    try {
      await platform.startupRecovery;
      const sources = new ScenarioFileSource(scenariosRoot)
        .list()
        .filter((entry) => entry.declaredScenarioId === "disk-scenario");
      assert.equal(sources.length, 2);
      for (const source of sources) {
        const request = {
          contractVersion: "experiment-schedule.v2",
          runName: "Buffer Sweep",
          scenarioSourceId: source.id,
          dimensions: [{ name: "-B", values: [500] }],
          repetitions: 1,
          inputs: { seed: "input:seed", applicationArchive: "input:archive" }
        };
        const preview = platform.controlUi.preview(request as any);
        const experiment = platform.controlUi.submit({
          previewId: preview.previewId,
          confirm: true
        });
        assert.match(experiment.id, /^buffer-sweep-[0-9a-f]{4}$/);
        assert.equal(experiment.name, "Buffer Sweep");
        assert.match(experiment.runs[0].id, /^buffer-sweep-[1-9][0-9]*-[0-9a-f]{4}$/);
        const run = platform.repositories.getRun(experiment.runs[0].id)!;
        assert.equal(
          (run.environmentSnapshot as any).inputs.databaseImage,
          "parkbench/openedge-db:fixture"
        );
        assert.equal(
          (run.environmentSnapshot as any).inputs.pasImage,
          "parkbench/openedge-pas:fixture"
        );
        const dashboard = platform.controlUi.createDashboard({
          experimentId: experiment.id,
          runIds: [run.id]
        });
        assert.match(dashboard.id, /^buffer-sweep-[0-9a-f]{4}$/);
        assert.equal(
          platform.controlUi.createDashboard({
            experimentId: experiment.id,
            runIds: [run.id]
          }).id,
          dashboard.id
        );
        assert.throws(
          () =>
            platform.controlUi.preview({
              ...request,
              inputs: { ...request.inputs, databaseImage: "parkbench/openedge-db:other" }
            } as any),
          /configured_input_override_forbidden/
        );
      }
    } finally {
      platform.close();
    }
  });

  it("keeps a queued scenario snapshot after its file changes or disappears", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-scenario-snapshot-"));
    const filename = path.join(root, "scenario.json");
    const original = JSON.parse(
      fs.readFileSync(
        path.resolve("tests/fixtures/simplify-run-workflow/scenarios/scenario-v2.json"),
        "utf8"
      )
    );
    fs.writeFileSync(filename, JSON.stringify(original));
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: path.join(root, "artifacts"),
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        discoveryRoots: { scenarios: root },
        openedge: {}
      } as any,
      { testMode: true }
    );
    try {
      await platform.startupRecovery;
      const sourceId = new ScenarioFileSource(root).list()[0].id;
      const request = {
        contractVersion: "experiment-schedule.v2" as const,
        runName: "Snapshot",
        scenarioSourceId: sourceId,
        dimensions: [{ name: "-B", values: [500] }],
        repetitions: 1,
        inputs: { seed: "input:seed", applicationArchive: "input:archive" }
      };
      const firstPreview = platform.controlUi.preview(request);
      const first = platform.controlUi.submit({ previewId: firstPreview.previewId, confirm: true });
      const firstSnapshot = platform.controlRepository.getRunMetadata(first.runs[0].id)!.snapshot;
      assert.equal((firstSnapshot.scenario as any).name, original.name);
      fs.writeFileSync(filename, JSON.stringify({ ...original, name: "Edited on disk" }));
      const secondPreview = platform.controlUi.preview({ ...request, runName: "Snapshot Later" });
      const second = platform.controlUi.submit({
        previewId: secondPreview.previewId,
        confirm: true
      });
      assert.equal(
        (platform.controlRepository.getRunMetadata(second.runs[0].id)!.snapshot.scenario as any)
          .name,
        "Edited on disk"
      );
      fs.rmSync(filename);
      assert.equal(
        (platform.controlRepository.getRunMetadata(first.runs[0].id)!.snapshot.scenario as any)
          .name,
        original.name
      );
      assert.equal(
        (platform.controlRepository.getRunMetadata(second.runs[0].id)!.snapshot.scenario as any)
          .name,
        "Edited on disk"
      );
      assert.throws(
        () => platform.controlUi.preview({ ...request, runName: "After Delete" }),
        /scenario_source_missing/
      );
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
