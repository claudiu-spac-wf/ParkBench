import Ajv from "ajv/dist/2020";
import schema from "./schemas/experiment-schedule-snapshot-v1.schema.json";
import { validateScenario } from "./validator";
import { validateDatabaseIopsCondition } from "./database-iops";
const valid = new Ajv({ strict: true }).compile(schema);
export const SAVED_SCHEDULE_VERSION = "experiment-schedule-snapshot.v1" as const;
export interface SavedScheduleSnapshot {
  contractVersion: typeof SAVED_SCHEDULE_VERSION;
  experiment: Record<string, any>;
  control: Record<string, any>;
  variants: Record<string, any>[];
  runs: Array<{
    row: Record<string, any>;
    environment: Record<string, any>;
    metadata: Record<string, any>;
    diagnosticsPolicy: Record<string, any>;
  }>;
}
export function validateSavedSchedule(value: unknown): asserts value is SavedScheduleSnapshot {
  const s = value as SavedScheduleSnapshot;
  if (
    !valid(value) ||
    !s ||
    s.contractVersion !== SAVED_SCHEDULE_VERSION ||
    !s.experiment?.id ||
    !s.control?.scenario_snapshot ||
    !Array.isArray(s.variants) ||
    !s.variants.length ||
    !Array.isArray(s.runs) ||
    !s.runs.length
  )
    throw Error("experiment_saved_schedule_incomplete");
  validateScenario(JSON.parse(s.control.scenario_snapshot));
  const ids = new Set<string>(),
    variants = new Set(s.variants.map((v) => v.id));
  for (const r of s.runs) {
    if (
      !r.row?.id ||
      r.row.experiment_id !== s.experiment.id ||
      ids.has(r.row.id) ||
      !variants.has(r.row.variant_id) ||
      !r.environment?.scenario ||
      !r.environment.inputs ||
      !r.environment.databaseIops ||
      !r.metadata?.run_id ||
      r.metadata.run_id !== r.row.id ||
      !r.diagnosticsPolicy
    )
      throw Error("experiment_saved_schedule_incomplete");
    validateScenario(r.environment.scenario);
    validateDatabaseIopsCondition(r.environment.databaseIops);
    ids.add(r.row.id);
  }
}
