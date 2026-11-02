import crypto from "node:crypto";
import {
  DatabaseIopsCondition,
  DatabaseIopsCoverage,
  DatabaseIopsEvidence,
  DatabaseIopsError,
  DatabaseIopsApplicationIntent,
  IopsRules,
  PersistIopsIntent,
  desiredIops,
  pendingDatabaseIops,
  unlimitedDatabaseIops,
  sameIopsRules,
  validateDatabaseIopsIntent,
  validateDatabaseIopsCoverage
} from "../../contracts/src/database-iops";
import { EngineApi } from "./engine-api";
export interface IopsSnapshot {
  coverage: DatabaseIopsCoverage;
  rules: IopsRules;
  kernel: Record<string, { riops: number | "max"; wiops: number | "max" }>;
  capability?: DatabaseIopsEvidence["capability"];
}
export function verifyIopsPolicy(
  condition: DatabaseIopsCondition,
  coverage: DatabaseIopsCoverage,
  rules: IopsRules,
  kernel: IopsSnapshot["kernel"],
  phase?: string
) {
  validateDatabaseIopsCoverage(coverage);
  const code = phase ? "database_iops_policy_drift" : "database_iops_unconfirmed";
  if (
    !sameIopsRules(rules, desiredIops(condition, coverage)) ||
    coverage.devices.some(
      (d) =>
        kernel[d.id]?.riops !== condition.readIopsPerDevice ||
        kernel[d.id]?.wiops !== condition.writeIopsPerDevice
    )
  )
    throw new DatabaseIopsError(code, undefined, "expected_observed_policy_mismatch");
}
function sameIdentity(a: DatabaseIopsCoverage, b: DatabaseIopsCoverage) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function activeKernelIops(kernel: IopsSnapshot["kernel"]) {
  return Object.entries(kernel)
    .filter(([, v]) => v.riops !== "max" || v.wiops !== "max")
    .sort(([a], [b]) => a.localeCompare(b));
}
async function bounded<T>(operation: Promise<T>, deadline: number, runtime = false): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DatabaseIopsError(
                runtime ? "database_iops_unconfirmed" : "database_iops_apply_failed",
                undefined,
                runtime ? "runtime_check_deadline" : "startup_deadline"
              )
            ),
          Math.max(0, deadline - Date.now())
        );
      })
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export async function applyIopsPolicy({
  api,
  inspect,
  condition,
  runId,
  experimentId,
  variantId,
  cancelled,
  persistIntent,
  deadline,
  ownedPrevious
}: {
  api: Pick<EngineApi, "requireFinite" | "updateIops">;
  inspect: (deadline: number) => Promise<IopsSnapshot>;
  condition: DatabaseIopsCondition;
  runId: string;
  experimentId: string;
  variantId: string;
  cancelled: () => boolean;
  persistIntent: PersistIopsIntent;
  deadline: number;
  ownedPrevious?: DatabaseIopsApplicationIntent;
}): Promise<DatabaseIopsEvidence> {
  if (cancelled()) throw Error("run_cancelled");
  if (condition.presetId === "unlimited" && !ownedPrevious) return unlimitedDatabaseIops();
  const e = pendingDatabaseIops(condition);
  let mutationStarted = false;
  const guard = () => {
    if (cancelled()) throw Error("run_cancelled");
    if (Date.now() >= deadline)
      throw new DatabaseIopsError("database_iops_apply_failed", e, "startup_deadline");
  };
  try {
    api.requireFinite();
    e.stage = "DISCOVERING";
    const before = await inspect(deadline);
    guard();
    e.coverage = before.coverage;
    e.owner = before.coverage.owner;
    e.capability = before.capability;
    if (before.coverage.owner.runId !== runId)
      throw new DatabaseIopsError("database_iops_policy_conflict", e, "run_owner_mismatch");
    if (
      before.rules.read.length ||
      before.rules.write.length ||
      activeKernelIops(before.kernel).length
    ) {
      if (
        !ownedPrevious ||
        !sameIdentity(ownedPrevious.coverage, before.coverage) ||
        !sameIopsRules(before.rules, ownedPrevious.desiredIops)
      )
        throw new DatabaseIopsError(
          "database_iops_policy_conflict",
          e,
          "existing_unowned_iops_rules"
        );
      if (
        activeKernelIops(before.kernel).some(
          ([device]) => !before.coverage.devices.some((d) => d.id === device)
        )
      )
        throw new DatabaseIopsError("database_iops_policy_conflict", e, "unowned_kernel_iops_rule");
      try {
        if (ownedPrevious.condition.presetId === "unlimited") {
          if (activeKernelIops(before.kernel).length) throw Error("owned_clear_not_effective");
        } else
          verifyIopsPolicy(ownedPrevious.condition, before.coverage, before.rules, before.kernel);
      } catch {
        throw new DatabaseIopsError(
          "database_iops_policy_conflict",
          e,
          "recorded_owned_policy_changed"
        );
      }
    }
    e.applicationIntent = validateDatabaseIopsIntent({
      contractVersion: "database-iops-application-intent.v1",
      attemptId: crypto.randomUUID(),
      experimentId,
      runId,
      variantId,
      preparedAt: new Date().toISOString(),
      condition,
      owner: before.coverage.owner,
      coverage: before.coverage,
      previousIops: before.rules,
      desiredIops: desiredIops(condition, before.coverage)
    });
    e.stage = "PERSISTING_INTENT";
    e.applicationOutcome = "PENDING";
    if (typeof persistIntent !== "function")
      throw new DatabaseIopsError("database_iops_apply_failed", e, "persistence_callback_required");
    try {
      await bounded(
        Promise.resolve().then(() => persistIntent(e.applicationIntent)),
        deadline
      );
    } catch (error) {
      if (cancelled()) throw Error("run_cancelled");
      throw new DatabaseIopsError(
        "database_iops_apply_failed",
        e,
        "intent_persistence_failed_or_expired"
      );
    }
    guard();
    const current = await inspect(deadline);
    guard();
    if (
      !sameIdentity(before.coverage, current.coverage) ||
      !sameIopsRules(before.rules, current.rules) ||
      JSON.stringify(activeKernelIops(before.kernel)) !==
        JSON.stringify(activeKernelIops(current.kernel))
    )
      throw new DatabaseIopsError(
        "database_iops_policy_conflict",
        e,
        "acknowledged_target_or_previous_policy_changed"
      );
    e.stage = "APPLYING";
    mutationStarted = true;
    await api.updateIops(e.owner.containerId, e.applicationIntent.desiredIops, deadline);
    e.appliedAt = new Date().toISOString();
    guard();
    e.stage = "VERIFYING";
    const applied = await inspect(deadline);
    guard();
    if (!sameIdentity(before.coverage, applied.coverage))
      throw new DatabaseIopsError("database_iops_unconfirmed", e, "updated_target_changed");
    e.verification.observed = { rules: applied.rules, kernel: applied.kernel };
    if (condition.presetId !== "unlimited")
      verifyIopsPolicy(condition, applied.coverage, applied.rules, applied.kernel);
    else if (
      (!sameIopsRules(applied.rules, e.applicationIntent.desiredIops) &&
        !sameIopsRules(applied.rules, { read: [], write: [] })) ||
      activeKernelIops(applied.kernel).length
    )
      throw new DatabaseIopsError("database_iops_unconfirmed", e, "owned_rules_not_cleared");
    e.mode = "native";
    e.applicationOutcome = "VERIFIED";
    e.stage = "VERIFIED";
    e.verifiedAt = new Date().toISOString();
    e.verification = {
      status: condition.presetId === "unlimited" ? "NO_ADDED_CAP" : "MATCHED",
      checks: 1,
      firstVerifiedAt: e.verifiedAt,
      lastVerifiedAt: e.verifiedAt
    };
    return e;
  } catch (error) {
    const stage = e.stage;
    e.applicationOutcome = mutationStarted ? "POSSIBLY_APPLIED" : "NOT_SENT";
    e.stage = cancelled() ? "CANCELLED" : "FAILED";
    e.verification.status = "UNAVAILABLE";
    const code = error instanceof DatabaseIopsError ? error.code : "database_iops_apply_failed";
    e.failure = {
      code,
      stage,
      reason:
        error instanceof DatabaseIopsError
          ? error.message.slice(0, 1024)
          : "application_unavailable",
      possiblyApplied: mutationStarted
    };
    if (cancelled()) throw Object.assign(new Error("run_cancelled"), { evidence: e });
    throw new DatabaseIopsError(code, e, e.failure.reason);
  }
}
export async function checkIopsPolicy(
  inspect: (deadline: number) => Promise<IopsSnapshot>,
  e: DatabaseIopsEvidence,
  phase: string,
  cancelled = () => false
): Promise<DatabaseIopsEvidence> {
  if (e.condition.presetId === "unlimited" || cancelled()) return e;
  const start = Date.now(),
    deadline = start + 500;
  try {
    const current = await bounded(inspect(deadline), deadline, true);
    if (cancelled()) return e;
    if (Date.now() > deadline)
      throw new DatabaseIopsError("database_iops_unconfirmed", undefined, "runtime_check_deadline");
    if (!sameIdentity(e.coverage, current.coverage))
      throw new DatabaseIopsError(
        "database_iops_unconfirmed",
        undefined,
        "owned_identity_or_coverage_changed"
      );
    try {
      verifyIopsPolicy(
        e.condition,
        current.coverage,
        current.rules,
        current.kernel,
        phase === "prewarmup" ? undefined : phase
      );
    } catch (error) {
      e.verification.observed = { rules: current.rules, kernel: current.kernel };
      throw error;
    }
    e.stage = "MONITORING";
    e.verification.checks++;
    e.verification.lastVerifiedAt = new Date().toISOString();
    e.verification.durationMs = Date.now() - start;
    return e;
  } catch (error) {
    if (cancelled()) return e;
    const code =
      error instanceof DatabaseIopsError && error.code === "database_iops_policy_drift"
        ? error.code
        : "database_iops_unconfirmed";
    e.failure = {
      code,
      stage: e.stage,
      phase,
      reason:
        error instanceof DatabaseIopsError
          ? error.message.slice(0, 1024)
          : "policy_probe_unavailable"
    };
    e.verification.status = code === "database_iops_policy_drift" ? "MISMATCH" : "UNAVAILABLE";
    throw new DatabaseIopsError(code, e, e.failure.reason);
  }
}
