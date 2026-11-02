import crypto from "node:crypto";
export function composeProjectName(runId: string): string {
  const safe = runId.toLowerCase().replace(/[^a-z0-9]/g, "-");
  return `parkbench-${safe.length <= 48 ? safe : safe.slice(0, 35) + "-" + crypto.createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
}

/** A run project can be valid for Docker while project+service exceeds one DNS
 * label. Keep short aliases stable and shorten only the generated namespace. */
export function runServiceAlias(projectName: string, service: string): string {
  if (![projectName, service].every((value) => /^[a-z0-9][a-z0-9-]*$/.test(value)))
    throw new Error("run_service_alias_invalid");
  const alias = `${projectName}-${service}`;
  if (alias.length <= 63) return alias;
  const projectLimit = 63 - service.length - 1;
  if (projectLimit < 14) throw new Error("run_service_alias_invalid");
  const namespace = crypto.createHash("sha256").update(projectName).digest("hex").slice(0, 12);
  return `${projectName.slice(0, projectLimit - 13)}-${namespace}-${service}`;
}
