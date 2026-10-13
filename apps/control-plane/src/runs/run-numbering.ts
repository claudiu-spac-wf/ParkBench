import type { Repositories } from "../db/repositories";
import { scheduleSlug } from "./name-derived-id";
export interface NumberedRunName {
  base: string;
  number: number;
  name: string;
}
/** A read inside the caller's savepoint. Saving runs in that same transaction
 * reserves the numbers; rollback releases them without a second reservation. */
export function nextRunNames(
  repositories: Repositories,
  inputBase: string,
  count: number
): NumberedRunName[] {
  const base = scheduleSlug(inputBase),
    prefix = `run_${base}-`;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("run_count_invalid");
  let highest = 0;
  const observe = (snapshot: Record<string, any>, name?: string) => {
    if (
      snapshot.runNameBase === base &&
      Number.isSafeInteger(snapshot.runNumber) &&
      snapshot.runNumber > 0
    )
      highest = Math.max(highest, snapshot.runNumber);
    for (const value of [name, snapshot.runName])
      if (typeof value === "string" && value.startsWith(prefix)) {
        const suffix = value.slice(prefix.length);
        if (/^\d+$/.test(suffix)) {
          const number = Number(suffix);
          if (!Number.isSafeInteger(number)) throw new Error("run_number_exhausted");
          highest = Math.max(highest, number);
        }
      }
  };
  for (const run of repositories.listAllRuns()) observe(run.environmentSnapshot ?? {}, run.name);
  for (const row of repositories.client.db
    .prepare("SELECT snapshot FROM control_run_metadata")
    .all() as any[])
    observe(JSON.parse(row.snapshot));
  if (!Number.isSafeInteger(highest + count)) throw new Error("run_number_exhausted");
  return Array.from({ length: count }, (_, i) => ({
    base,
    number: highest + i + 1,
    name: `${prefix}${highest + i + 1}`
  }));
}
