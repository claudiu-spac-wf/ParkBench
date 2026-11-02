import type { DatabaseIopsCondition } from "../../../../packages/contracts/src/database-iops";
export function databaseIopsPresentation(snapshot: any): {
  status: "recorded" | "not_recorded" | "unavailable";
  text: string;
  condition?: DatabaseIopsCondition;
  verification?: string;
  artifactId?: string;
  evidence?: any;
} {
  const evidence = snapshot?.databaseIopsEvidence;
  const condition =
    snapshot?.requestedConfiguration?.databaseIops ??
    snapshot?.databaseIops ??
    snapshot?.variant?.databaseIops ??
    evidence?.condition;
  if (!condition) return { status: "not_recorded", text: "Not recorded" };
  const validRate = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
  if (
    typeof condition.label !== "string" ||
    typeof condition.catalogVersion !== "string" ||
    !(
      (condition.readIopsPerDevice === null && condition.writeIopsPerDevice === null) ||
      (validRate(condition.readIopsPerDevice) && validRate(condition.writeIopsPerDevice))
    )
  )
    return { status: "unavailable", text: "Recorded disk condition unavailable" };
  const format = (n: number) => n.toLocaleString("en-US");
  const text =
    condition.readIopsPerDevice === null
      ? `${condition.label} — no added cap`
      : `${condition.label} — ${format(condition.readIopsPerDevice)} read / ${format(condition.writeIopsPerDevice)} write IOPS per device`;
  return {
    status: "recorded",
    text,
    condition,
    evidence,
    verification: evidence?.verification?.status ?? "Requested",
    artifactId: evidence?.artifactId
  };
}
