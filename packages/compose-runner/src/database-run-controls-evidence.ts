import { DatabaseRunControls } from "../../contracts/src/database-run-controls";

export interface DatabaseRunControlsEvidence {
  contractVersion: "db-run-controls-evidence.v1";
  capturedAt: string;
  verification: "pending" | "matched" | "mismatched" | "unavailable";
  writerHealth: "verified" | "lost" | "stopped" | "unavailable";
  reason: string;
  lastSuccessAt?: string | null;
  observed?: {
    contractVersion: "db-startup-state.v1";
    capturedAt: string;
    nativeClusterKiB: number;
    biBuffers: number;
    connectionCapacity: number;
    connectedCount: number;
    apwCount: number;
    biwCount: number;
    writers: Array<{ type: "APW" | "BIW"; pid: number; connectionId: number }>;
  } | null;
  preparation?: Record<string, unknown> | null;
  logs?: string[];
}
export class DatabaseRunControlsError extends Error {
  constructor(
    readonly code: string,
    readonly evidence?: DatabaseRunControlsEvidence
  ) {
    super(code);
  }
}
export function validateDatabaseRunControlsEvidence(
  value: unknown,
  controls: DatabaseRunControls,
  expectedBuffers?: number,
  previous?: DatabaseRunControlsEvidence
): DatabaseRunControlsEvidence {
  const e = value as DatabaseRunControlsEvidence;
  const invalid = () => {
    throw new DatabaseRunControlsError("database_run_control_unapplied", e);
  };
  if (
    !e ||
    e.contractVersion !== "db-run-controls-evidence.v1" ||
    !Number.isFinite(Date.parse(e.capturedAt)) ||
    !["pending", "matched", "mismatched", "unavailable"].includes(e.verification) ||
    !["verified", "lost", "stopped", "unavailable"].includes(e.writerHealth) ||
    typeof e.reason !== "string"
  )
    invalid();
  if (e.verification !== "matched" || e.writerHealth !== "verified") {
    if (e.reason && /^database_(?:writer|bi_preparation|run_control)_/.test(e.reason))
      throw new DatabaseRunControlsError(e.reason, e);
    throw new DatabaseRunControlsError(
      previous ? "database_writer_lost" : "database_run_control_unapplied",
      e
    );
  }
  const o = e.observed;
  if (
    !o ||
    o.contractVersion !== "db-startup-state.v1" ||
    !Number.isFinite(Date.parse(o.capturedAt)) ||
    ![
      o.nativeClusterKiB,
      o.biBuffers,
      o.connectionCapacity,
      o.connectedCount,
      o.apwCount,
      o.biwCount
    ].every(Number.isSafeInteger) ||
    o.nativeClusterKiB < 16 ||
    o.nativeClusterKiB > 262128 ||
    o.nativeClusterKiB % 16 ||
    o.biBuffers < 3 ||
    o.connectionCapacity < 1 ||
    o.connectedCount < 1 ||
    o.apwCount !== controls.apwCount ||
    o.biwCount !== Number(controls.biwEnabled) ||
    !Array.isArray(o.writers) ||
    o.writers.length !== o.apwCount + o.biwCount ||
    new Set(o.writers.map((w) => w.pid)).size !== o.writers.length ||
    o.writers.some(
      (w) =>
        !["APW", "BIW"].includes(w.type) ||
        !Number.isSafeInteger(w.pid) ||
        w.pid < 1 ||
        !Number.isSafeInteger(w.connectionId) ||
        w.connectionId < 0
    ) ||
    o.writers.filter((w) => w.type === "APW").length !== o.apwCount ||
    o.writers.filter((w) => w.type === "BIW").length !== o.biwCount ||
    (controls.biCluster.mode === "override" &&
      o.nativeClusterKiB !== controls.biCluster.nativeKiB) ||
    (expectedBuffers !== undefined && o.biBuffers !== expectedBuffers)
  )
    invalid();
  if (
    previous?.observed &&
    JSON.stringify([...previous.observed.writers].sort((a, b) => a.pid - b.pid)) !==
      JSON.stringify([...o!.writers].sort((a, b) => a.pid - b.pid))
  )
    throw new DatabaseRunControlsError("database_writer_lost", e);
  return e;
}
