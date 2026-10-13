import crypto from "node:crypto";
export function composeProjectName(runId: string): string {
  const safe=runId.toLowerCase().replace(/[^a-z0-9]/g,"-");
  return `parkbench-${safe.length<=48?safe:safe.slice(0,35)+"-"+crypto.createHash("sha256").update(runId).digest("hex").slice(0,12)}`;
}
