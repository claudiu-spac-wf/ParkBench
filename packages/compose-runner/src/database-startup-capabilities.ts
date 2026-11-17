import { DatabaseIopsError } from "../../contracts/src/database-iops";
export function requireDatabaseStartupCapabilities(
  labels: Record<string, string> | undefined,
  requirements: { finite: boolean; writers: boolean; setup: boolean }
): void {
  if (
    requirements.writers &&
    labels?.["org.parkbench.writer-supervision"] !== "writer-supervision.v1"
  )
    throw Error("database_writer_unavailable:image_supervision_capability");
  if (
    requirements.finite &&
    labels?.["org.parkbench.database-iops-startup"] !== "database-iops-startup.v2"
  )
    throw new DatabaseIopsError(
      "database_iops_unsupported",
      undefined,
      "image_startup_gate_capability"
    );
  if (requirements.setup && labels?.["org.parkbench.database-setup"] !== "database-setup.v1")
    throw Error("database_setup_unavailable:image_capability");
}
