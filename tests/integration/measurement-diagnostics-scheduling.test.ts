import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { ScenarioFileSource } from "../../apps/control-plane/src/catalog/scenario-source";
import { canonicalMatrixRequest } from "../../packages/contracts/src/matrix-expansion";
import { DIAGNOSTIC_DEFAULTS } from "../../packages/contracts/src/measurement-diagnostics";
import { buildRunContext } from "../../apps/control-plane/src/runs/run-context";
const summary = { contractVersion: "measurement-diagnostics-config.v1", mode: "summary" } as const;
const trace = { ...summary, mode: "trace" } as const;
const request = {
  runName: "diagnostic-schedule",
  scenario: { id: "crud-rest", version: "1.0.0" },
  dimensions: [
    { name: "-B", values: [500, 1000] },
    { name: "-n", values: [100, 120] }
  ],
  repetitions: 2
};
async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-diagnostic-scheduling-"));
  const settings = { ...DIAGNOSTIC_DEFAULTS };
  const config = {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    artifactRoot: root,
    prometheusUrl: "http://localhost:9090",
    prometheusRetention: "7d",
    measurementDiagnostics: settings,
    discoveryRoots: { scenarios: path.resolve("tests/fixtures/simplify-run-workflow/scenarios") },
    openedge: {}
  };
  const platform = createPlatform(config as any, { testMode: true });
  t.after(() => {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await platform.startupRecovery;
  platform.scenarios.register(scenario);
  platform.controlUi.syncExistingScenarios();
  return { platform, settings, config };
}
test("canonical omission equals summary and trace differs without changing load dimensions", () => {
  assert.equal(
    canonicalMatrixRequest(request),
    canonicalMatrixRequest({ ...request, measurementDiagnostics: summary } as any)
  );
  assert.notEqual(
    canonicalMatrixRequest(request),
    canonicalMatrixRequest({ ...request, measurementDiagnostics: trace } as any)
  );
});
for (const mode of [undefined, summary, trace])
  test(`every preview page and submitted repetition retains ${mode?.mode ?? "legacy default"}`, async (t) => {
    const { platform } = await fixture(t);
    const first = platform.controlUi.preview(
      { ...request, measurementDiagnostics: mode } as any,
      undefined,
      2
    );
    assert.equal(first.cellCount, 4);
    assert.equal(first.runCount, 8);
    const cells = [...first.cells.items];
    let page = first;
    while (page.cells.hasMore) {
      page = platform.controlUi.previewCells(first.previewId, page.cells.nextPageToken, 2);
      cells.push(...page.cells.items);
    }
    assert.equal(cells.length, 8);
    assert.ok(
      cells.every((c) => (c as any).measurementDiagnostics?.mode === (mode?.mode ?? "summary"))
    );
    const submitted = platform.controlUi.submit(
      { previewId: first.previewId, confirm: true },
      "diagnostics-submit-1"
    );
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          platform.controlUi.submit(
            { previewId: first.previewId, confirm: true },
            "diagnostics-submit-1"
          )
        )
      ),
      JSON.parse(JSON.stringify(submitted))
    );
    for (const item of submitted.runs) {
      const run = platform.repositories.getRun(item.id)!;
      assert.equal(
        (run.environmentSnapshot as any).measurementDiagnostics.mode,
        mode?.mode ?? "summary"
      );
      assert.equal(
        (run.environmentSnapshot as any).resolvedMeasurementDiagnostics.summaryLimitBytes,
        DIAGNOSTIC_DEFAULTS.summaryLimitBytes
      );
      assert.equal(
        (run.environmentSnapshot as any).variant.measurementDiagnostics.mode,
        mode?.mode ?? "summary"
      );
      assert.equal(
        (buildRunContext(run).effective as any).measurementDiagnostics.mode,
        mode?.mode ?? "summary"
      );
    }
  });
test("submission freezes current validated operator limits, then later configuration changes cannot refill runs", async (t) => {
  const { platform, settings } = await fixture(t);
  const p = platform.controlUi.preview({ ...request, dimensions: [], repetitions: 1 });
  settings.summaryLimitBytes = 16 * 1024 ** 2;
  const submitted = platform.controlUi.submit({ previewId: p.previewId, confirm: true });
  settings.summaryLimitBytes = 32 * 1024 ** 2;
  const run = platform.repositories.getRun(submitted.runs[0].id)!;
  assert.equal(
    (run.environmentSnapshot as any).resolvedMeasurementDiagnostics.summaryLimitBytes,
    16 * 1024 ** 2
  );
});
test("invalid late operator bounds and nested public settings fail before run creation", async (t) => {
  const { platform, settings } = await fixture(t);
  for (const value of [
    { ...summary, mode: "off" },
    { ...summary, summaryLimitBytes: 12 },
    { ...summary, contractVersion: "unknown" },
    {}
  ])
    assert.throws(() =>
      platform.controlUi.preview({ ...request, measurementDiagnostics: value } as any)
    );
  const p = platform.controlUi.preview({ ...request, dimensions: [], repetitions: 1 });
  settings.summaryLimitBytes = 64 * 1024 ** 2 + 1;
  assert.throws(() => platform.controlUi.submit({ previewId: p.previewId, confirm: true }));
  assert.equal(platform.repositories.listAllRuns().length, 0);
});
test("v2 discovered scenarios carry trace statically through all cells", async (t) => {
  const { platform, config } = await fixture(t);
  const source = new ScenarioFileSource(config.discoveryRoots.scenarios)
    .list()
    .find((e) => e.declaredScenarioId === "disk-scenario")!;
  const p = platform.controlUi.preview({
    contractVersion: "experiment-schedule.v2",
    runName: "diagnostics-v2",
    scenarioSourceId: source.id,
    dimensions: [{ name: "-B", values: [500, 1000] }],
    repetitions: 2,
    inputs: { seed: "input:seed", applicationArchive: "input:archive" },
    measurementDiagnostics: trace
  } as any);
  assert.equal(p.runCount, 4);
  assert.ok(p.cells.items.every((c) => (c as any).measurementDiagnostics.mode === "trace"));
  const accepted = platform.controlUi.submit({ previewId: p.previewId, confirm: true });
  assert.equal(accepted.runs.length, 4);
  assert.ok(
    accepted.runs.every(
      (r) =>
        (platform.repositories.getRun(r.id)!.environmentSnapshot as any).measurementDiagnostics
          .mode === "trace"
    )
  );
});

test("mode changes require a new preview and cannot override frozen reviewed cells at submission", async (t) => {
  const { platform } = await fixture(t);
  const config: any = { ...summary };
  const first = platform.controlUi.preview({
    ...request,
    dimensions: [],
    repetitions: 1,
    measurementDiagnostics: config
  } as any);
  config.mode = "trace";
  assert.equal(
    (platform.controlUi.previewCells(first.previewId).cells.items[0] as any).measurementDiagnostics
      .mode,
    "summary"
  );
  assert.throws(
    () =>
      platform.controlUi.submit({
        previewId: first.previewId,
        confirm: true,
        measurementDiagnostics: trace
      } as any),
    /preview_configuration_frozen/
  );
  const replacement = platform.controlUi.preview({
    ...request,
    dimensions: [],
    repetitions: 1,
    measurementDiagnostics: config
  } as any);
  assert.equal((replacement.cells.items[0] as any).measurementDiagnostics.mode, "trace");
});
