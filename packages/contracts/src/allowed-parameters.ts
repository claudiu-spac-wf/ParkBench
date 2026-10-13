import {databaseParameterOptions} from './database-parameter-options';
export const ALLOWED_PARAMETERS: Record<
  string,
  { type: "number" | "string" | "boolean"; min?: number; max?: number }
> = {
  "pas.maxThreads": { type: "number", min: 1, max: 10000 },
  "database.readOnly": { type: "boolean" },
  "database.metricsEnabled": { type: "boolean" },
  "workload.seed": { type: "number", min: 0, max: 4294967295 },
  "database.cpuLimit": { type: "number", min: 0.1, max: 64 },
  "pas.cpuLimit": { type: "number", min: 0.1, max: 64 },
  "network.databaseLatencyMs": { type: "number", min: 0, max: 1000 }
};

// Scenario-editor compatibility: native types/bounds come from the same audited catalog.
for(const p of databaseParameterOptions().parameters.filter(p=>p.available))ALLOWED_PARAMETERS[p.name]={type:p.kind==='flag'?'boolean':p.kind==='integer'||p.kind==='decimal'?'number':'string',min:p.minimum,max:p.maximum};
