import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseIopsError, DatabaseIopsEvidence } from "../../contracts/src/database-iops";
export interface DatabaseIopsStartupGate {
  contractVersion: "database-iops-startup.v1";
  runId: string;
  executionRevision: string;
  nonce: string;
  directory: string;
  timeoutMs: number;
  heldAt?: string;
  releasePublishedAt?: string;
  consumedAt?: string;
}
export function createDatabaseStartupGate(
  runId: string,
  executionRevision: string,
  runtimeDirectory: string,
  timeoutMs: number
): DatabaseIopsStartupGate {
  if (
    !runId ||
    !executionRevision ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 86400000
  )
    throw Error("database_iops_apply_failed:startup_gate_identity");
  const nonce = randomUUID();
  return {
    contractVersion: "database-iops-startup.v1",
    runId,
    executionRevision,
    nonce,
    directory: path.join(runtimeDirectory, "iops-startup-" + nonce),
    timeoutMs
  };
}
export const startupGateBinding = (gate: DatabaseIopsStartupGate) =>
  `${gate.runId}:${gate.executionRevision}:${gate.nonce}\n`;
function guard(
  gate: DatabaseIopsStartupGate,
  deadline: number,
  cancelled: () => boolean,
  current?: () => void
) {
  current?.();
  if (cancelled()) throw Error("run_cancelled");
  if (Date.now() >= deadline)
    throw new DatabaseIopsError("database_iops_apply_failed", undefined, "startup_gate_deadline");
  if (
    fs.lstatSync(gate.directory).isSymbolicLink() ||
    fs.realpathSync(gate.directory) !== path.resolve(gate.directory)
  )
    throw new DatabaseIopsError("database_iops_policy_conflict", undefined, "startup_gate_path");
}
export async function waitForDatabaseStartupGate(
  gate: DatabaseIopsStartupGate,
  deadline: number,
  cancelled: () => boolean,
  running?: () => Promise<boolean>,
  marker = "held"
): Promise<void> {
  while (true) {
    guard(gate, deadline, cancelled);
    const file = path.join(gate.directory, marker);
    if (fs.existsSync(file)) {
      if (
        fs.lstatSync(file).isSymbolicLink() ||
        fs.statSync(file).size > 1024 ||
        fs.readFileSync(file, "utf8") !== startupGateBinding(gate)
      )
        throw new DatabaseIopsError(
          "database_iops_policy_conflict",
          undefined,
          "startup_gate_identity"
        );
      if (marker === "held") gate.heldAt = new Date(fs.statSync(file).mtimeMs).toISOString();
      return;
    }
    if (running && !(await running()))
      throw new DatabaseIopsError(
        "database_iops_apply_failed",
        undefined,
        "startup_gate_container_exited"
      );
    await new Promise((r) => setTimeout(r, 500));
  }
}
export function publishDatabaseStartupRelease(
  gate: DatabaseIopsStartupGate,
  evidence: DatabaseIopsEvidence,
  deadline: number,
  cancelled: () => boolean,
  current?: () => void
): void {
  guard(gate, deadline, cancelled, current);
  const intent = evidence.applicationIntent;
  if (
    evidence.verification.status !== "MATCHED" ||
    evidence.applicationOutcome !== "VERIFIED" ||
    !intent ||
    intent.runId !== gate.runId ||
    intent.executionRevision !== gate.executionRevision ||
    intent.startupNonce !== gate.nonce ||
    fs.readFileSync(path.join(gate.directory, "held"), "utf8") !== startupGateBinding(gate) ||
    fs.existsSync(path.join(gate.directory, "consumed"))
  )
    throw new DatabaseIopsError("database_iops_unconfirmed", evidence, "startup_gate_unverified");
  const file = path.join(gate.directory, "release"),
    temporary = file + "." + randomUUID() + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o644);
  try {
    fs.writeFileSync(fd, startupGateBinding(gate));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    guard(gate, deadline, cancelled, current);
    fs.renameSync(temporary, file);
    const dir = fs.openSync(gate.directory, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
    gate.releasePublishedAt = new Date().toISOString();
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function inspectDatabaseStartupGate(
  gate: DatabaseIopsStartupGate,
  releaseIntentPersisted = false
): {
  observedStage: "HELD" | "RELEASE_POSSIBLE" | "CONSUMED" | "MISSING";
  releasePossiblyConsumed: boolean;
} {
  if (
    fs.existsSync(gate.directory) &&
    (fs.lstatSync(gate.directory).isSymbolicLink() ||
      fs.realpathSync(gate.directory) !== path.resolve(gate.directory))
  )
    throw new DatabaseIopsError("database_iops_policy_conflict", undefined, "recovery_gate_path");
  for (const [file, observedStage] of [
    ["consumed", "CONSUMED"],
    ["release", "RELEASE_POSSIBLE"]
  ] as const) {
    const target = path.join(gate.directory, file);
    if (fs.existsSync(target)) {
      if (
        fs.lstatSync(target).isSymbolicLink() ||
        fs.statSync(target).size > 1024 ||
        fs.readFileSync(target, "utf8") !== startupGateBinding(gate)
      )
        throw new DatabaseIopsError(
          "database_iops_policy_conflict",
          undefined,
          "recovery_gate_identity"
        );
      return { observedStage, releasePossiblyConsumed: true };
    }
  }
  return releaseIntentPersisted || gate.releasePublishedAt
    ? { observedStage: "RELEASE_POSSIBLE", releasePossiblyConsumed: true }
    : {
        observedStage: fs.existsSync(path.join(gate.directory, "held")) ? "HELD" : "MISSING",
        releasePossiblyConsumed: false
      };
}
