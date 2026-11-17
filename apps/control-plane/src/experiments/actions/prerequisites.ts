import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
const verified = new Set<string>();
async function docker(args: string[]) {
  return (await exec("docker", args, { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
/** Prove actual raw-label export, tied to cAdvisor identity and its active arguments. */
export async function verifyMetricRevisionCapability(
  cadvisorUrl: string,
  image: string
): Promise<void> {
  let probe: string | undefined;
  const nonce = randomUUID();
  try {
    const ids = (
      await docker([
        "ps",
        "--filter",
        "label=com.docker.compose.project=parkbench-platform",
        "--filter",
        "label=com.docker.compose.service=cadvisor",
        "--format",
        "{{.ID}}"
      ])
    )
      .split("\n")
      .filter(Boolean);
    if (ids.length !== 1) throw Error();
    const [info] = JSON.parse(await docker(["inspect", ids[0]]));
    const signature = JSON.stringify([info.Id, info.State?.StartedAt, info.Config?.Cmd]);
    if (verified.has(signature)) return;
    const args = info.Config?.Cmd ?? [];
    if (
      !args.some(
        (s: string) =>
          s.startsWith("--whitelisted_container_labels=") &&
          s.split("=")[1].split(",").includes("parkbench.execution_revision")
      )
    )
      throw Error();
    probe = await docker([
      "run",
      "-d",
      "--network",
      "none",
      "--name",
      `parkbench-revision-probe-${nonce}`,
      "--label",
      `parkbench.feature_probe=${nonce}`,
      "--label",
      "parkbench.managed=true",
      "--label",
      `parkbench.execution_revision=${nonce}`,
      "--entrypoint",
      "node",
      image,
      "-e",
      "setInterval(()=>{},1000)"
    ]);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const response = await fetch(cadvisorUrl.replace(/\/$/, "") + "/metrics", {
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok || !response.body) throw Error();
      const reader = response.body.getReader();
      let bytes = 0,
        body = "";
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 16 * 1024 * 1024) throw Error();
          body += decoder.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (body.includes(`container_label_parkbench_execution_revision="${nonce}"`)) {
        verified.clear();
        verified.add(signature);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Error();
  } catch {
    throw new Error("experiment_metric_revision_unavailable");
  } finally {
    if (probe) {
      const [info] = JSON.parse(await docker(["inspect", probe]));
      if (info.Config?.Labels?.["parkbench.feature_probe"] !== nonce)
        throw new Error("experiment_ownership_mismatch");
      await docker(["rm", "-f", probe]);
    }
  }
}
