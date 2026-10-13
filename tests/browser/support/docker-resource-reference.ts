import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type DockerCpuReading = { read: string; totalNanoseconds: number };
/** Integrate independent Engine counters over the actual window, not sparse instantaneous percentages. */
export function dockerWindowCpu(first: DockerCpuReading, last: DockerCpuReading): number {
  const elapsed = (Date.parse(last.read) - Date.parse(first.read)) / 1000;
  const delta = last.totalNanoseconds - first.totalNanoseconds;
  if (!(elapsed > 0) || delta < 0) throw new Error("docker_cpu_reference_window_invalid");
  return (100 * delta) / 1e9 / elapsed;
}

export async function dockerCpuReader() {
  const context = JSON.parse(
    String((await promisify(execFile)("docker", ["context", "inspect"])).stdout)
  )[0];
  const endpoint =
    (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) || context.Endpoints.docker.Host;
  if (!endpoint.startsWith("unix://"))
    throw new Error("licensed_docker_stats_unix_endpoint_required");
  const socketPath = endpoint.slice("unix://".length);
  return (id: string) =>
    new Promise<DockerCpuReading>((resolve, reject) => {
      const request = http.get(
        {
          socketPath,
          path: `/containers/${encodeURIComponent(id)}/stats?stream=false&one-shot=true`
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024)
              request.destroy(new Error("docker_stats_reference_too_large"));
          });
          response.on("end", () => {
            try {
              const value = JSON.parse(body);
              if (
                response.statusCode !== 200 ||
                !value.read ||
                !Number.isFinite(value.cpu_stats?.cpu_usage?.total_usage)
              )
                throw new Error("docker_stats_reference_unavailable");
              resolve({
                read: value.read,
                totalNanoseconds: value.cpu_stats.cpu_usage.total_usage
              });
            } catch (error) {
              reject(error);
            }
          });
          response.on("error", reject);
        }
      );
      request.setTimeout(30_000, () =>
        request.destroy(new Error("docker_stats_reference_timeout"))
      );
      request.on("error", reject);
    });
}
