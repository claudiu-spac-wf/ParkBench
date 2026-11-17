import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
export const commandKeyHash = (operation: string, key: string) =>
  createHash("sha256")
    .update(JSON.stringify([operation, key]))
    .digest("hex");
export function assertCommandCurrent(db: DatabaseSync, operation: string, key: string): void {
  const row: any = db
    .prepare("SELECT expires_at FROM retired_command_keys WHERE key_hash=?")
    .get(commandKeyHash(operation, key));
  if (row?.expires_at > Date.now()) throw Error("experiment_revision_stale");
}
