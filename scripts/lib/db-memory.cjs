// A hard limit for the database process and container-charged filesystem cache.
// Equal memory and swap limits prevent a database from exhausting host swap.
const SETTING = "PARKBENCH_DB_MEMORY_LIMIT";
function databaseMemoryLimit(env = process.env) {
  const value = String(env[SETTING] ?? "10g").trim().toLowerCase();
  const match = value.match(/^(\d+(?:\.\d+)?)([bkmg])$/);
  const bytes = match ? Number(match[1]) * ({b:1,k:1024,m:1024**2,g:1024**3}[match[2]]) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 6 * 1024**2)
    throw new Error(`platform_setting_invalid:${SETTING}`);
  return value;
}
function databaseMemoryArguments(env = process.env, maximumBytes) {
  let limit = databaseMemoryLimit(env);
  if (maximumBytes !== undefined) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 6 * 1024 ** 2)
      throw new Error("database_memory_ceiling_invalid");
    const match = limit.match(/^(\d+(?:\.\d+)?)([bkmg])$/);
    const bytes = Number(match[1]) * ({b:1,k:1024,m:1024**2,g:1024**3}[match[2]]);
    limit = Math.min(bytes, maximumBytes) + "b";
  }
  return ["--memory", limit, "--memory-swap", limit];
}
module.exports = { databaseMemoryLimit, databaseMemoryArguments };
