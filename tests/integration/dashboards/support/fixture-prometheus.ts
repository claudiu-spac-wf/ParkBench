import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const PROMETHEUS_IMAGE = "prom/prometheus:v3.5.0";
export interface FixturePrometheus {
  url: string;
  stop(): void;
}

/** Disposable stored-timestamp fixture; named volumes also work on Docker Desktop. */
export async function startFixturePrometheus(openMetrics: string): Promise<FixturePrometheus> {
  const suffix = randomUUID();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-dashboards-"));
  const volume = `parkbench-dashboards-data-${suffix}`;
  const importer = `parkbench-dashboards-import-${suffix}`;
  const name = `parkbench-dashboards-prom-${suffix}`;
  const docker = (args: string[]) =>
    execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const container of [name, importer]) {
      try {
        docker(["rm", "-f", container]);
      } catch {
        /* Already removed or creation failed. */
      }
    }
    try {
      docker(["volume", "rm", volume]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    fs.writeFileSync(path.join(directory, "fixture.om"), openMetrics);
    docker(["volume", "create", volume]);
    docker([
      "create",
      "--memory=512m",
      "--memory-swap=512m",
      "--name",
      importer,
      "--user",
      "0",
      "-v",
      `${volume}:/data`,
      "--entrypoint",
      "promtool",
      PROMETHEUS_IMAGE,
      "tsdb",
      "create-blocks-from",
      "openmetrics",
      "/data/fixture.om",
      "/data/tsdb"
    ]);
    docker(["cp", path.join(directory, "fixture.om"), `${importer}:/data/fixture.om`]);
    docker(["start", "-a", importer]);
    const exitCode = docker(["inspect", "--format", "{{.State.ExitCode}}", importer]).trim();
    if (exitCode !== "0") throw new Error(`fixture_import_failed:${exitCode}`);
    docker(["rm", importer]);
    docker([
      "run",
      "-d",
      "--memory=512m",
      "--memory-swap=512m",
      "--name",
      name,
      "--user",
      "0",
      "-p",
      "127.0.0.1::9090",
      "-v",
      `${volume}:/data`,
      PROMETHEUS_IMAGE,
      "--config.file=/etc/prometheus/prometheus.yml",
      "--storage.tsdb.path=/data/tsdb",
      "--storage.tsdb.retention.time=30d",
      "--query.lookback-delta=30s"
    ]);
    const port = docker(["port", name, "9090"]).trim().split(":").at(-1);
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${url}/-/ready`, { signal: AbortSignal.timeout(2_000) })).ok)
          return { url, stop };
      } catch {
        /* Not ready yet. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("fixture_prometheus_ready_timeout");
  } catch (error) {
    stop();
    throw error;
  }
}
