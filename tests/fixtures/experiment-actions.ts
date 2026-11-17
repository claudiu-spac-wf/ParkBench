import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { ScenarioFileSource } from "../../apps/control-plane/src/catalog/scenario-source";

export async function actionFixture(
  options: Parameters<typeof createPlatform>[1] = {},
  dbPath = ":memory:",
  matrix: { values: number[]; repetitions: number; runName?: string } = {
    values: [500, 1000],
    repetitions: 2
  }
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-actions-"));
  const scenarios = path.resolve("tests/fixtures/simplify-run-workflow/scenarios");
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath,
      artifactRoot: path.join(root, "artifacts"),
      runRoot: path.join(root, "runs"),
      prometheusUrl: "http://127.0.0.1:9090",
      prometheusRetention: "7d",
      discoveryRoots: { scenarios },
      openedge: {}
    } as any,
    { ...options, testMode: true }
  );
  await platform.startupRecovery;
  const source = new ScenarioFileSource(scenarios)
    .list()
    .find((x) => x.relativePath === "scenario-v2.json")!;
  const preview = platform.controlUi.preview({
    runName: matrix.runName ?? "Action validation",
    scenarioSourceId: source.id,
    dimensions: [{ name: "-B", values: matrix.values }],
    repetitions: matrix.repetitions
  } as any);
  const submitted = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
  const runIds = submitted.runs.map((x) => x.id);
  function terminal() {
    runIds.forEach((id, i) => {
      const run = platform.repositories.getRun(id)!;
      run.state = i === 0 ? "FAILED" : "SUCCEEDED";
      run.measurementValidity = i === 0 ? "UNAVAILABLE" : "VALID";
      run.cleanupStatus = "COMPLETE";
      run.finishedAt = new Date().toISOString();
      if (!i) run.failureCode = "database_writer_lost";
      platform.repositories.saveRun(run);
    });
    platform.repositories.updateExperimentStatus(submitted.id, "FAILED", new Date().toISOString());
    platform.controlRepository.updateControlExperiment(submitted.id, { status: "FAILED" });
  }
  function additional() {
    const preview = platform.controlUi.preview({
      runName: "Unrelated sentinel",
      scenarioSourceId: source.id,
      dimensions: [{ name: "-B", values: [500] }],
      repetitions: 1
    } as any);
    return platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
  }
  return {
    platform,
    root,
    submitted,
    runIds,
    terminal,
    additional,
    close() {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
