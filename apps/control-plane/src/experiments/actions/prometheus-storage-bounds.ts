import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
async function docker(args: string[]) {
  return (await exec("docker", args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}
/** Read block time bounds only; empty series metadata cannot establish sample absence. */
export async function prometheusStorageBounds(
  containerId?: string
): Promise<{ start?: number; end?: number; hostname?: string }> {
  try {
    const ids = containerId
      ? [containerId]
      : (
          await docker([
            "ps",
            "-q",
            "--filter",
            "label=com.docker.compose.project=parkbench-platform",
            "--filter",
            "label=com.docker.compose.service=prometheus"
          ])
        )
          .split("\n")
          .filter(Boolean);
    if (ids.length !== 1) throw Error();
    const hostname = await docker(["inspect", "--format", "{{.Config.Hostname}}", ids[0]]);
    const text = await docker([
      "exec",
      ids[0],
      "sh",
      "-ec",
      'printf "["; separator=; for file in /prometheus/*/meta.json; do [ -f "$file" ] || continue; printf "%s" "$separator"; cat "$file"; separator=,; done; printf "]"'
    ]);
    const blocks = JSON.parse(text);
    if (!Array.isArray(blocks)) throw Error();
    if (
      blocks.some(
        (b) => !Number.isFinite(b.minTime) || !Number.isFinite(b.maxTime) || b.maxTime < b.minTime
      )
    )
      throw Error();
    return blocks.length
      ? {
          hostname,
          start: Math.min(...blocks.map((b) => b.minTime)) / 1000,
          end: Math.max(...blocks.map((b) => b.maxTime)) / 1000
        }
      : { hostname };
  } catch {
    throw Error("experiment_metric_storage_bounds_unavailable");
  }
}
