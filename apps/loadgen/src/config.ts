import fs from "node:fs";
import { Scenario } from "../../../packages/contracts/src/scenario";
export interface LoadgenConfig {
  scenario: Scenario;
  runId: string;
  experimentId: string;
  variantId: string;
  repetition: number;
  targetBaseUrl: string;
  summaryPath: string;
  shutdownFile?: string;
  workloadStartFile?: string;
  workloadSeed?: number;
}
export function loadLoadgenConfig(env: NodeJS.ProcessEnv = process.env): LoadgenConfig {
  const scenarioPath = env.PARKBENCH_SCENARIO_PATH ?? "scenario.json";
  const workloadSeed =
    env.PARKBENCH_LOAD_SEED === undefined ? undefined : Number(env.PARKBENCH_LOAD_SEED);
  if (
    workloadSeed !== undefined &&
    (!Number.isSafeInteger(workloadSeed) || workloadSeed < 0 || workloadSeed > 4294967295)
  )
    throw new Error("loadgen_seed_invalid");
  return {
    scenario: JSON.parse(fs.readFileSync(scenarioPath, "utf8")),
    runId: env.PARKBENCH_RUN_ID ?? "run_local",
    experimentId: env.PARKBENCH_EXPERIMENT_ID ?? "exp_local",
    variantId: env.PARKBENCH_VARIANT_ID ?? "baseline",
    repetition: Number(env.PARKBENCH_REPETITION ?? 1),
    targetBaseUrl: env.PARKBENCH_TARGET_BASE_URL ?? "http://localhost:8810",
    summaryPath: env.PARKBENCH_SUMMARY_PATH ?? "summary.json",
    shutdownFile: env.PARKBENCH_SHUTDOWN_FILE,
    workloadStartFile: env.PARKBENCH_WORKLOAD_START_FILE,
    workloadSeed
  };
}
