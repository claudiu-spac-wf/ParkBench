import { DIAGNOSTIC_DEFAULTS } from "../../../../../packages/contracts/src/measurement-diagnostics";
import {
  SavedScheduleSnapshot,
  SAVED_SCHEDULE_VERSION,
  validateSavedSchedule
} from "../../../../../packages/contracts/src/experiment-schedule-snapshot";
import { validateScenario } from "../../../../../packages/contracts/src/validator";
import type { Repositories } from "../../db/repositories";
const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
const pick = (v: any, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => v?.[k] !== undefined).map((k) => [k, structuredClone(v[k])])
  );
const ENV_KEYS = [
  "runName",
  "runNumber",
  "runNameBase",
  "scenario",
  "measurementDiagnostics",
  "requestedConfiguration",
  "scheduleName",
  "inputs",
  "openedgeImageManifestPath",
  "variant",
  "databaseStartup",
  "databaseIops",
  "databaseSetup",
  "databaseRunControls",
  "effectiveConfiguration",
  "parameterAdapterVersion",
  "metricContracts",
  "sourceCadences",
  "deterministicLoadSeed"
];
const META_KEYS = [
  "runName",
  "runNumber",
  "runNameBase",
  "scenario",
  "scenarioSourceId",
  "scenarioSourcePath",
  "scenarioRelativePath",
  "scenarioDeclaredId",
  "scenarioDeclaredVersion",
  "scenarioCapturedAt",
  "scheduleName",
  "requiredMeasurements",
  "assets",
  "parameters",
  "measurementDiagnostics",
  "databaseStartup",
  "databaseSetup",
  "databaseIops",
  "databaseRunControls",
  "matrixCell",
  "repetition",
  "executionPolicy"
];
function cleanEnvironment(environment: any): Record<string, any> {
  const clean = pick(environment, ENV_KEYS);
  if (clean.databaseStartup)
    clean.databaseStartup = {
      ...clean.databaseStartup,
      parameters: clean.databaseStartup.parameters.map((p: any) => ({
        ...pick(p, [
          "name",
          "displayValue",
          "source",
          "overrides",
          "sourceReference",
          "applicability"
        ]),
        verification: "pending"
      }))
    };
  return clean;
}
export function captureSavedSchedule(
  repositories: Repositories,
  experimentId: string,
  useCache = true,
  onlyRunId?: string
): SavedScheduleSnapshot {
  try {
    const db = repositories.client.db;
    const cached: any = db
      .prepare("SELECT schedule_json FROM experiment_execution WHERE experiment_id=?")
      .get(experimentId);
    if (useCache && cached?.schedule_json) {
      const s = parse(cached.schedule_json);
      if (onlyRunId) {
        s.runs = s.runs.filter((r: any) => r.row.id === onlyRunId);
        s.variants = s.variants.filter((v: any) =>
          s.runs.some((r: any) => r.row.variant_id === v.id)
        );
      }
      validateSavedSchedule(s);
      const actual = repositories
        .listRuns(experimentId)
        .filter((r) => !onlyRunId || r.id === onlyRunId)
        .map((r) => r.id)
        .sort();
      if (
        s.experiment.id !== experimentId ||
        JSON.stringify(actual) !== JSON.stringify(s.runs.map((r: any) => r.row.id).sort())
      )
        throw Error();
      return s;
    }
    const experiment: any = db.prepare("SELECT * FROM experiments WHERE id=?").get(experimentId);
    const control: any = db
      .prepare("SELECT * FROM control_experiments WHERE experiment_id=?")
      .get(experimentId);
    if (!experiment || !control || !parse(control.scenario_snapshot)) throw Error();
    validateScenario(parse(control.scenario_snapshot));
    const variants = db
      .prepare("SELECT * FROM variants WHERE experiment_id=? ORDER BY rowid")
      .all(experimentId) as any[];
    const runs = (
      db
        .prepare("SELECT * FROM runs WHERE experiment_id=? ORDER BY rowid")
        .all(experimentId) as any[]
    )
      .filter((row) => !onlyRunId || row.id === onlyRunId)
      .map((row) => {
        const environment = parse(row.environment_snapshot),
          metadata: any = db
            .prepare("SELECT * FROM control_run_metadata WHERE run_id=?")
            .get(row.id);
        if (!environment || !metadata || !environment.resolvedMeasurementDiagnostics) throw Error();
        const cleanMeta = {
          ...pick(metadata, [
            "run_id",
            "experiment_id",
            "cell_ordinal",
            "repetition",
            "values_json",
            "effective_configuration"
          ]),
          snapshot: pick(parse(metadata.snapshot), META_KEYS)
        };
        return {
          row: pick(row, [
            "id",
            "experiment_id",
            "variant_id",
            "repetition",
            "compose_project",
            "resource_namespace"
          ]),
          environment: cleanEnvironment(environment),
          metadata: cleanMeta,
          diagnosticsPolicy: pick(
            environment.resolvedMeasurementDiagnostics,
            Object.keys(DIAGNOSTIC_DEFAULTS)
          )
        };
      });
    const snapshot: SavedScheduleSnapshot = {
      contractVersion: SAVED_SCHEDULE_VERSION,
      experiment: pick(experiment, [
        "id",
        "scenario_id",
        "scenario_version",
        "comparison_mode",
        "baseline_variant_id",
        "repetitions",
        "inputs",
        "created_at"
      ]),
      control: pick(control, [
        "experiment_id",
        "request_json",
        "scenario_snapshot",
        "matrix_spec",
        "execution_policy",
        "baseline_run_id",
        "created_at"
      ]),
      variants: onlyRunId
        ? variants.filter((v) => runs.some((r) => r.row.variant_id === v.id))
        : variants,
      runs
    };
    validateSavedSchedule(snapshot);
    return snapshot;
  } catch {
    throw Error("experiment_saved_schedule_incomplete");
  }
}
export function saveSubmittedSchedule(repositories: Repositories, experimentId: string): void {
  const snapshot = captureSavedSchedule(repositories, experimentId, false);
  repositories.client.db
    .prepare("UPDATE experiment_execution SET schedule_json=? WHERE experiment_id=?")
    .run(JSON.stringify(snapshot), experimentId);
}
