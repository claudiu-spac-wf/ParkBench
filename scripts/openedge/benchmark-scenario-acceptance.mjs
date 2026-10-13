import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { repositoryRoot, fingerprintSeed } from "./read-calibration.mjs";
import { buildScenarios } from "./generate-benchmark-scenarios.mjs";
const require = createRequire(import.meta.url);
export function selectScenarios(calibration, scenarioId) {
  const scenarios = buildScenarios(calibration);
  if (!scenarioId) return scenarios;
  const selected = scenarios.filter((s) => s.id === scenarioId);
  if (!selected.length) throw new Error("benchmark_scenario_unknown:" + scenarioId);
  return selected;
}
export async function runScenarios(options, calibration) {
  const helper = require("tsx/cjs/api").require(
    path.join(repositoryRoot, "tests/helpers/benchmark-scenario.ts"),
    import.meta.url
  );
  const directory = path.join(
    repositoryRoot,
    ".parkbench/validation/feature019/scenarios-" + Date.now()
  );
  fs.mkdirSync(directory, { recursive: true });
  const scenarios = selectScenarios(calibration, options.scenario);
  const runs = [];
  for (const scenario of scenarios) {
    if ((await fingerprintSeed(options.seed)) !== calibration.seed.fingerprint)
      throw new Error("benchmark_reference_changed_before_copy");
    console.log("benchmark_scenario_start:" + scenario.id);
    runs.push(
      await helper.runBenchmarkScenario({
        evidenceRoot: directory,
        seedRoot: path.resolve(options.seed),
        scenario
      })
    );
  }
  return {
    runs,
    selectedScenarioIds: scenarios.map((s) => s.id),
    evidenceRoot: path.relative(repositoryRoot, directory),
    ok: runs.length === scenarios.length && runs.every((r) => r.ok)
  };
}
