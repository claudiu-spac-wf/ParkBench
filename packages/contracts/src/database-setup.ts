import Ajv2020 from "ajv/dist/2020";
import schema from "./schemas/database-setup-v1.schema.json";
export const DATABASE_SETUP_VERSION = "database-setup.v1" as const;
export const DATABASE_SETUP_FAILURE_CODES = [
  "database_setup_script_unavailable",
  "database_setup_unavailable",
  "database_setup_failed",
  "database_setup_start_failed",
  "database_setup_shutdown_unconfirmed",
  "database_setup_evidence_invalid",
  "database_setup_replay_refused",
  "database_setup_process_unconfirmed"
] as const;
export type SetupDefinitionId = "idxbuild" | "idxcompact" | "tablereorg" | "custom";
export type IndexBuildSet = { id: string; additionalArguments?: string[] } & (
  | { scope: "all" }
  | { scope: "table"; table: string }
  | { scope: "indexes"; indexes: Array<{ table: string; index: string }> }
);
export interface IndexCompactSet {
  id: string;
  index: string;
  compactionPercent?: number;
  mode?: "unusedblocks";
  additionalArguments?: string[];
}
export interface TableReorgSet {
  id: string;
  table: string;
  useIndex?: string;
  additionalArguments?: string[];
}
export interface CustomSetupSet {
  id: string;
  input: string;
}
export type SetupOptionSet = IndexBuildSet | IndexCompactSet | TableReorgSet | CustomSetupSet;
export type DatabaseSetupStep = { id: string } & (
  | { definitionId: "idxbuild"; optionSets: IndexBuildSet[] }
  | { definitionId: "idxcompact"; optionSets: IndexCompactSet[] }
  | { definitionId: "tablereorg"; optionSets: TableReorgSet[] }
  | { definitionId: "custom"; scriptRef: string; optionSets: CustomSetupSet[] }
);
export interface DatabaseSetup {
  contractVersion: typeof DATABASE_SETUP_VERSION;
  steps: DatabaseSetupStep[];
}
const validateConfiguration = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
export function validateDatabaseSetup(input: unknown): DatabaseSetup {
  if (!validateConfiguration(input))
    throw new Error(`database_setup_invalid:${JSON.stringify(validateConfiguration.errors)}`);
  const value = input as DatabaseSetup,
    ids = new Set<string>();
  for (const step of value.steps) {
    if (ids.has(step.id)) throw new Error("database_setup_invalid:duplicate_step_id");
    ids.add(step.id);
    const sets = new Set<string>();
    for (const set of step.optionSets) {
      if (sets.has(set.id)) throw new Error("database_setup_invalid:duplicate_set_id");
      sets.add(set.id);
    }
  }
  return value;
}
export function normalizeDatabaseSetup(input: unknown): DatabaseSetup | undefined {
  if (input === undefined) return undefined;
  const value = validateDatabaseSetup(input);
  return value.steps.length ? value : undefined;
}
export type SetupState =
  "NOT_REQUESTED" | "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
export type SetupSetState = Exclude<SetupState, "NOT_REQUESTED"> | "NOT_EXECUTED";
export type SetupPhase =
  | "staged"
  | "preparing"
  | "step-running"
  | "temporary-startup"
  | "temporary-ready"
  | "utility"
  | "waiting-processes"
  | "temporary-shutdown"
  | "awaiting-normal-start"
  | "released"
  | "complete";
export interface SetupSetOutcome {
  id: string;
  state: SetupSetState;
  startedAt: string | null;
  finishedAt: string | null;
  exitStatus: number | null;
  primaryInvocationObserved?: boolean;
  primaryExitStatus?: number | null;
  shellExitStatus?: number | null;
  processScopeState?: "ACTIVE" | "QUIESCENT" | "UNCONFIRMED";
  quiescentAt?: string | null;
  reason?: string;
  stdout?: string;
  stderr?: string;
}
export interface SetupStepOutcome {
  id: string;
  definitionId: SetupDefinitionId;
  state: SetupSetState;
  optionSets: SetupSetOutcome[];
  startedAt: string | null;
  finishedAt: string | null;
  startup?: { state: string; exitStatus: number | null };
  shutdown?: { state: string; exitStatus: number | null };
}
export interface DatabaseSetupEvidence {
  contractVersion: "database-setup-evidence.v1";
  runId: string;
  attemptId: string;
  state: SetupState;
  phase: SetupPhase;
  startedAt: string | null;
  finishedAt: string | null;
  activeStepId?: string;
  activeOptionSetId?: string;
  steps: SetupStepOutcome[];
  cleanup: "NOT_REQUIRED" | "PENDING" | "CONFIRMED" | "UNCERTAIN";
  normalStart: "NOT_AUTHORIZED" | "AUTHORIZED" | "STARTED";
  failure?: { code: string; message: string; stepId?: string; optionSetId?: string };
  normalStartedAt?: string;
}
export interface DatabaseSetupManifest {
  contractVersion: "database-setup-manifest.v1";
  runId: string;
  attemptId: string;
  sequence: DatabaseSetup;
  capturedAt: string;
  databaseName: string;
  databaseDirectory: string;
  image: string;
  maintenanceArguments: string[];
  scripts: Array<{ scriptRef: string; sourcePath: string; stagedPath: string; capturedAt: string }>;
  paths: { input: string; output: string; control: string };
}
const states = [
  "NOT_REQUESTED",
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
];
const phases = [
  "staged",
  "preparing",
  "step-running",
  "temporary-startup",
  "temporary-ready",
  "utility",
  "waiting-processes",
  "temporary-shutdown",
  "awaiting-normal-start",
  "released",
  "complete"
];
const stamp = (v: unknown) =>
  v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
const exit = (v: unknown) =>
  v === null || (Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 255);
export function customSetupSetSucceeded(set: Partial<SetupSetOutcome>): boolean {
  return (
    set.primaryInvocationObserved === true &&
    set.primaryExitStatus === 0 &&
    set.shellExitStatus === 0 &&
    set.processScopeState === "QUIESCENT" &&
    typeof set.quiescentAt === "string" &&
    stamp(set.quiescentAt)
  );
}
export function validateDatabaseSetupEvidence(input: unknown): DatabaseSetupEvidence {
  const v = input as DatabaseSetupEvidence;
  const invalid = () => {
    throw new Error("database_setup_evidence_invalid");
  };
  if (
    !v ||
    typeof v.runId !== "string" ||
    typeof v.attemptId !== "string" ||
    v.contractVersion !== "database-setup-evidence.v1" ||
    !v.runId ||
    !v.attemptId ||
    !states.includes(v.state) ||
    !phases.includes(v.phase) ||
    !stamp(v.startedAt) ||
    !stamp(v.finishedAt) ||
    !Array.isArray(v.steps) ||
    !["NOT_REQUIRED", "PENDING", "CONFIRMED", "UNCERTAIN"].includes(v.cleanup) ||
    !["NOT_AUTHORIZED", "AUTHORIZED", "STARTED"].includes(v.normalStart)
  )
    invalid();
  const stepIds = new Set<string>();
  for (const step of v.steps) {
    if (
      !step ||
      typeof step.id !== "string" ||
      !step.id ||
      stepIds.has(step.id) ||
      ![...states.filter((s) => s !== "NOT_REQUESTED"), "NOT_EXECUTED"].includes(step.state) ||
      !["idxbuild", "idxcompact", "tablereorg", "custom"].includes(step.definitionId) ||
      !Array.isArray(step.optionSets) ||
      !stamp(step.startedAt) ||
      !stamp(step.finishedAt)
    )
      invalid();
    stepIds.add(step.id);
    const setIds = new Set<string>();
    for (const set of step.optionSets) {
      if (
        !set ||
        typeof set.id !== "string" ||
        !set.id ||
        setIds.has(set.id) ||
        ![...states.filter((s) => s !== "NOT_REQUESTED"), "NOT_EXECUTED"].includes(set.state) ||
        !stamp(set.startedAt) ||
        !stamp(set.finishedAt) ||
        !exit(set.exitStatus)
      )
        invalid();
      setIds.add(set.id);
      if (
        set.primaryInvocationObserved !== undefined &&
        typeof set.primaryInvocationObserved !== "boolean"
      )
        invalid();
      if (set.primaryExitStatus !== undefined && !exit(set.primaryExitStatus)) invalid();
      if (set.shellExitStatus !== undefined && !exit(set.shellExitStatus)) invalid();
      if (
        set.processScopeState !== undefined &&
        !["ACTIVE", "QUIESCENT", "UNCONFIRMED"].includes(set.processScopeState)
      )
        invalid();
      if (set.quiescentAt !== undefined && !stamp(set.quiescentAt)) invalid();
      if (
        step.definitionId === "custom" &&
        set.state === "SUCCEEDED" &&
        !customSetupSetSucceeded(set)
      )
        invalid();
    }
    if (step.state === "SUCCEEDED" && step.optionSets.some((set) => set.state !== "SUCCEEDED"))
      invalid();
  }
  if (
    v.state === "SUCCEEDED" &&
    (v.cleanup === "UNCERTAIN" || v.steps.some((s) => s.state !== "SUCCEEDED"))
  )
    invalid();
  return v;
}
export function pendingSetupEvidence(
  runId: string,
  attemptId: string,
  setup?: DatabaseSetup
): DatabaseSetupEvidence {
  return {
    contractVersion: "database-setup-evidence.v1",
    runId,
    attemptId,
    state: setup?.steps.length ? "PENDING" : "NOT_REQUESTED",
    phase: "staged",
    startedAt: null,
    finishedAt: null,
    cleanup: "NOT_REQUIRED",
    normalStart: "NOT_AUTHORIZED",
    steps: (setup?.steps ?? []).map((step) => ({
      id: step.id,
      definitionId: step.definitionId,
      state: "PENDING" as const,
      startedAt: null,
      finishedAt: null,
      optionSets: step.optionSets.map((set) => ({
        id: set.id,
        state: "PENDING" as const,
        startedAt: null,
        finishedAt: null,
        exitStatus: null
      }))
    }))
  };
}

/** Presentation metadata; utility targets remain native names and errors are retained. */
export const DATABASE_SETUP_DEFINITIONS = [
  {
    id: "idxbuild",
    name: "Rebuild indexes",
    description:
      "Offline PROUTIL IDXBUILD. Run all indexes, a table's indexes, or selected table/index pairs. Each setting runs in order on the same database copy.",
    fields: {
      scope: "All, table, or selected indexes. Selected indexes use a finite native Some dialogue.",
      table: "Owner-qualified native table name, such as PUB.Customer.",
      indexes:
        "Ordered table and index targets, passed without substitution. On OpenEdge 12.8 Some prompts, use the native unqualified table name; owner-qualified table scope is available separately.",
      additionalArguments:
        "Additional literal native argument tokens. UTF-8 internal code page is supplied."
    }
  },
  {
    id: "idxcompact",
    name: "Compact index",
    description:
      "Offline PROUTIL IDXCOMPACT for one index per setting. Omit the percentage to retain the native default of 80.",
    fields: {
      index: "Fully qualified native index name, such as PUB.Customer.CustNum.",
      compactionPercent: "Target utilization, 50 through 100. Omitted uses native default 80.",
      mode: "Unused blocks compacts unused blocks instead of specifying a percentage.",
      additionalArguments: "Additional literal native argument tokens."
    }
  },
  {
    id: "tablereorg",
    name: "Reorganize tables",
    description:
      "PROUTIL TABLEREORG requires Type II storage. One temporary broker serves all settings, then shuts down before normal benchmark startup.",
    fields: {
      table: "Owner-qualified table in a Type II area.",
      useIndex:
        "Optional active, non-word ordering index. Omit to use the native primary-index default.",
      additionalArguments: "Additional literal native argument tokens."
    }
  }
] as const;

export interface SetupScriptEntry {
  scriptRef: string;
  displayName: string;
  relativePath: string;
  availability: "AVAILABLE" | "UNAVAILABLE";
  reason?: string;
}
export interface SetupScriptsDiscovery {
  contractVersion: "database-setup-scripts.v1";
  state: "READY" | "EMPTY" | "DEGRADED" | "FAILED";
  discoveredAt: string;
  items: SetupScriptEntry[];
  reason?: string;
}
