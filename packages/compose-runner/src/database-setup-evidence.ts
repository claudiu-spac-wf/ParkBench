import fs from "node:fs";
import path from "node:path";
import {
  DatabaseSetupManifest,
  DatabaseSetupEvidence,
  pendingSetupEvidence,
  validateDatabaseSetupEvidence,
  DATABASE_SETUP_FAILURE_CODES
} from "../../contracts/src/database-setup";
const ordinal = (i: number) => String(i + 1).padStart(4, "0");
function json(file: string): any {
  if (fs.statSync(file).size > 1024 * 1024) throw new Error("database_setup_evidence_invalid:size");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("database_setup_evidence_invalid:json");
  }
}
export function readDatabaseSetupEvidence(manifest: DatabaseSetupManifest): DatabaseSetupEvidence {
  const evidence = pendingSetupEvidence(manifest.runId, manifest.attemptId, manifest.sequence);
  const statusPath = path.join(manifest.paths.output, "status.json");
  if (!fs.existsSync(statusPath)) return evidence;
  const status = json(statusPath);
  if (
    status.contractVersion !== "database-setup-status.v1" ||
    status.runId !== manifest.runId ||
    status.attemptId !== manifest.attemptId ||
    !["RUNNING", "PENDING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(status.state) ||
    !Number.isFinite(Date.parse(status.capturedAt))
  )
    throw new Error("database_setup_evidence_invalid:owner_or_state");
  if (
    !Number.isInteger(status.step) ||
    status.step < 0 ||
    status.step > manifest.sequence.steps.length ||
    !Number.isInteger(status.optionSet) ||
    status.optionSet < 0 ||
    (status.step === 0 && status.optionSet !== 0)
  )
    throw new Error("database_setup_evidence_invalid:ordinal");
  evidence.state = status.state;
  evidence.phase = status.phase;
  const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status.state);
  const startFile = path.join(manifest.paths.output, "started-at"),
    finishFile = path.join(manifest.paths.output, "finished-at");
  if (fs.existsSync(startFile)) evidence.startedAt = fs.readFileSync(startFile, "utf8").trim();
  if (terminal)
    evidence.finishedAt = fs.existsSync(finishFile)
      ? fs.readFileSync(finishFile, "utf8").trim()
      : status.capturedAt;
  if (status.step > 0) {
    evidence.activeStepId = manifest.sequence.steps[status.step - 1].id;
    if (status.optionSet > 0) {
      const set = manifest.sequence.steps[status.step - 1].optionSets[status.optionSet - 1];
      if (!set) throw new Error("database_setup_evidence_invalid:set_ordinal");
      evidence.activeOptionSetId = set.id;
    }
  }
  evidence.steps.forEach((step, si) => {
    const root = path.join(manifest.paths.output, "steps", ordinal(si));
    for (const phase of ["startup", "shutdown"] as const) {
      const file = path.join(root, phase + ".exit");
      if (fs.existsSync(file)) {
        const exit = Number(fs.readFileSync(file, "utf8").trim());
        if (!Number.isInteger(exit) || exit < 0 || exit > 255)
          throw new Error("database_setup_evidence_invalid:exit");
        step[phase] = {
          state:
            phase === "shutdown"
              ? fs.existsSync(path.join(root, "shutdown.confirmed"))
                ? "CONFIRMED"
                : "UNCONFIRMED"
              : exit === 0
                ? "STARTED"
                : "FAILED",
          exitStatus: exit
        };
      }
    }
    step.optionSets.forEach((set, oi) => {
      const base = path.join(root, ordinal(oi)),
        file = base + ".json";
      if (fs.existsSync(file)) {
        const record = json(file);
        const allowed = [
          "state",
          "exitStatus",
          "startedAt",
          "finishedAt",
          "primaryInvocationObserved",
          "primaryExitStatus",
          "shellExitStatus",
          "processScopeState",
          "quiescentAt"
        ];
        if (Object.keys(record).some((key) => !allowed.includes(key)))
          throw new Error("database_setup_evidence_invalid:set_fields");
        Object.assign(set, record);
      } else if (terminal) set.state = "NOT_EXECUTED";
      if (fs.existsSync(base + ".stdout"))
        set.stdout = path.relative(manifest.paths.output, base + ".stdout");
      if (fs.existsSync(base + ".stderr"))
        set.stderr = path.relative(manifest.paths.output, base + ".stderr");
      if (set.startedAt && (!evidence.startedAt || set.startedAt < evidence.startedAt))
        evidence.startedAt = set.startedAt;
    });
    step.startedAt = step.optionSets.find((s) => s.startedAt)?.startedAt ?? null;
    step.finishedAt = [...step.optionSets].reverse().find((s) => s.finishedAt)?.finishedAt ?? null;
    step.state = step.optionSets.every((s) => s.state === "SUCCEEDED")
      ? "SUCCEEDED"
      : (step.optionSets.find((s) => ["FAILED", "CANCELLED", "INTERRUPTED"].includes(s.state))
          ?.state ??
        (si === status.step - 1
          ? status.state === "FAILED"
            ? "FAILED"
            : "RUNNING"
          : terminal
            ? "NOT_EXECUTED"
            : "PENDING"));
  });
  for (const step of evidence.steps)
    if (["PENDING", "RUNNING"].includes(step.state)) step.finishedAt = null;
  if (evidence.state === "FAILED" && status.step > 0)
    evidence.steps[status.step - 1].state = "FAILED";
  if (evidence.state === "FAILED") {
    const code = DATABASE_SETUP_FAILURE_CODES.includes(status.code)
      ? status.code
      : "database_setup_failed";
    evidence.failure = {
      code,
      message: code,
      stepId: evidence.activeStepId,
      optionSetId: evidence.activeOptionSetId
    };
  }
  evidence.cleanup = evidence.steps.some(
    (s) =>
      (s.definitionId === "tablereorg" && s.startup && !s.shutdown) ||
      s.shutdown?.state === "UNCONFIRMED" ||
      (terminal &&
        s.definitionId === "custom" &&
        s.optionSets.some(
          (set) =>
            ["FAILED", "CANCELLED"].includes(set.state) && set.processScopeState !== "QUIESCENT"
        ))
  )
    ? "UNCERTAIN"
    : "NOT_REQUIRED";
  if (fs.existsSync(path.join(manifest.paths.output, "normal-started"))) {
    const owner = fs
      .readFileSync(path.join(manifest.paths.output, "normal-started"), "utf8")
      .trim();
    if (owner !== `${manifest.runId}:${manifest.attemptId}`)
      throw new Error("database_setup_evidence_invalid:normal_owner");
    evidence.normalStart = "STARTED";
    evidence.normalStartedAt = fs
      .statSync(path.join(manifest.paths.output, "normal-started"))
      .mtime.toISOString();
  } else if (fs.existsSync(path.join(manifest.paths.control, "normal-start-release")))
    evidence.normalStart = "AUTHORIZED";
  return validateDatabaseSetupEvidence(evidence);
}
