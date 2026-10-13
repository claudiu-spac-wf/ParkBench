import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HttpPrometheusClient } from "../../../packages/metrics/src/prometheus-client";
import { dockerCpuReader, dockerWindowCpu } from "./docker-resource-reference";
const execute = promisify(execFile);
const docker = async (...args: string[]) =>
  String((await execute("docker", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mean = (values: number[]) => values.reduce((n, v) => n + v, 0) / values.length;
function usedBytes(text: string) {
  const match = text
    .split("/")[0]
    .trim()
    .match(/^([\d.]+)\s*([KMGT]?i?B)$/);
  if (!match) throw new Error("docker_memory_units_unknown");
  const units: Record<string, number> = {
    B: 1,
    kB: 1000,
    KB: 1000,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4
  };
  return Number(match[1]) * units[match[2]];
}
/** Independent Docker windows and raw cgroup/source evidence, retained as test diagnostics. */
export async function captureLicensedResourceWindows(
  request: any,
  uiUrl: string,
  prometheusUrl: string,
  runId: string
) {
  const deadline = Date.now() + 1_200_000;
  while (true) {
    const response = await request.get(
        new URL(`/api/v1/runs/${encodeURIComponent(runId)}`, uiUrl).href
      ),
      run = await response.json();
    if (run.state === "MEASURING" || run.phase === "measuring") break;
    if (
      ["FAILED", "CANCELLED", "INCOMPLETE", "SUCCEEDED", "INTERRUPTED"].includes(run.state) ||
      Date.now() > deadline
    )
      throw new Error("licensed_measurement_window_unavailable");
    await pause(1000);
  }
  const ids = (await docker("ps", "-q", "--filter", `label=parkbench.run_id=${runId}`))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const containers = [];
  for (const id of ids) {
    const labels = JSON.parse(await docker("inspect", "--format", "{{json .Config.Labels}}", id)),
      service = labels["com.docker.compose.service"];
    if (service === "database" || /^pas-\d+$/.test(service ?? ""))
      containers.push({ id: (await docker("inspect", "--format", "{{.Id}}", id)).trim(), service });
  }
  if (
    !containers.some((c) => c.service === "database") ||
    !containers.some((c) => /^pas-\d+$/.test(c.service))
  )
    throw new Error("licensed_owned_resources_missing");
  const client = new HttpPrometheusClient(prometheusUrl),
    windows: any[] = [];
  const readDockerCpu = await dockerCpuReader();
  const cgroup = async (id: string) => {
    try {
      return await docker(
        "exec",
        id,
        "sh",
        "-c",
        'for name in /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.stat /sys/fs/cgroup/memory/memory.usage_in_bytes /sys/fs/cgroup/memory/memory.stat; do if [ -r "$name" ]; then echo "$name"; cat "$name"; fi; done'
      );
    } catch {
      return "cgroup_read_unavailable";
    }
  };
  for (let index = 0; index < 3; index++) {
    const cpuStart = await Promise.all(containers.map((c) => readDockerCpu(c.id)));
    const start = Math.min(...cpuStart.map((c) => Date.parse(c.read) / 1000)),
      initial = await Promise.all(
        containers.map(async (c) => ({ id: c.id, data: await cgroup(c.id) }))
      ),
      observations: any[] = [];
    while (Date.now() / 1000 < start + 60) {
      const samples = (
        await docker(
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          ...containers.map((c) => c.id)
        )
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      observations.push({
        at: Date.now() / 1000,
        samples: samples.map((s) => ({
          id: s.ID,
          cpuPercent: Number(s.CPUPerc.replace("%", "")),
          usedBytes: usedBytes(s.MemUsage)
        }))
      });
      await pause(Math.min(5000, Math.max(0, (start + 60) * 1000 - Date.now())));
    }
    const cpuEnd = await Promise.all(containers.map((c) => readDockerCpu(c.id)));
    const end = Math.max(...cpuEnd.map((c) => Date.parse(c.read) / 1000)),
      raw: any[] = [];
    for (const metric of [
      "container_cpu_usage_seconds_total",
      "container_memory_working_set_bytes",
      "container_memory_usage_bytes",
      "container_memory_cache",
      "container_start_time_seconds"
    ]) {
      for (const labels of [
        `run_id=${JSON.stringify(runId)}`,
        `container_label_parkbench_run_id=${JSON.stringify(runId)}`
      ])
        raw.push(
          ...(await client.queryRawRange(`${metric}{${labels}}`, start, end, 5, {
            includeExactEnd: true,
            priority: "finalization"
          }))
        );
    }
    const comparisons = containers.map((container, containerIndex) => {
      const points = observations.flatMap((o) =>
          o.samples.filter((s: any) => container.id.startsWith(s.id))
        ),
        owned = raw.filter(
          (s) =>
            s.labels.id?.includes(container.id) && s.labels.job === "parkbench-run-owned-cadvisor"
        );
      const cpu = owned.filter((s) => s.metricName === "container_cpu_usage_seconds_total"),
        total = cpu.filter((s) => !s.labels.cpu || s.labels.cpu === "total"),
        series = new Map<string, any[]>();
      for (const sample of total.length ? total : cpu) {
        const list = series.get(sample.labels.cpu ?? "total") ?? [];
        list.push(sample);
        series.set(sample.labels.cpu ?? "total", list);
      }
      let prometheusCpu = 0;
      for (const samples of series.values()) {
        samples.sort((a, b) => a.timestamp - b.timestamp);
        let delta = 0,
          duration = 0;
        for (let i = 1; i < samples.length; i++) {
          const a = samples[i - 1],
            b = samples[i],
            dt = b.timestamp - a.timestamp;
          if (dt > 0 && dt <= 7.501 && b.value >= a.value) {
            delta += b.value - a.value;
            duration += dt;
          }
        }
        if (!duration) throw new Error("licensed_cpu_observations_missing");
        prometheusCpu += (100 * delta) / duration;
      }
      const memory = owned
        .filter((s) => s.metricName === "container_memory_working_set_bytes")
        .sort((a, b) => a.timestamp - b.timestamp);
      let integral = 0,
        duration = 0;
      for (let i = 1; i < memory.length; i++) {
        const a = memory[i - 1],
          b = memory[i],
          dt = b.timestamp - a.timestamp;
        if (dt > 0 && dt <= 7.501) {
          integral += ((a.value + b.value) * dt) / 2;
          duration += dt;
        }
      }
      if (!points.length || !duration || !series.size)
        throw new Error("licensed_resource_observations_missing");
      const dockerCpu = dockerWindowCpu(cpuStart[containerIndex], cpuEnd[containerIndex]),
        dockerMemory = mean(points.map((p: any) => p.usedBytes)),
        prometheusMemory = integral / duration;
      return {
        container,
        dockerCpu,
        prometheusCpu,
        cpuTolerance: Math.max(2, 0.1 * dockerCpu),
        dockerMemory,
        prometheusMemory,
        memoryTolerance: Math.max(16 * 1024 * 1024, 0.1 * dockerMemory)
      };
    });
    windows.push({
      start,
      end,
      durationSeconds: end - start,
      initial,
      final: await Promise.all(
        containers.map(async (c) => ({ id: c.id, data: await cgroup(c.id) }))
      ),
      observations,
      cpuStart,
      cpuEnd,
      raw,
      comparisons
    });
  }
  return {
    runId,
    containers,
    windows,
    memoryCause:
      "requires inspection of these matched identities, jobs, cgroup hierarchy and inactive-file readings"
  };
}
