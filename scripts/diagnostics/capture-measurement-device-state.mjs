import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CampaignClient } from "./measurement-campaign.mjs";
const platformServices = new Set([
  "cadvisor",
  "control-plane",
  "grafana",
  "node-exporter",
  "prometheus",
  "web"
]);
// A container can bind a parent /sys over its own cgroup mount (notably cAdvisor).
// Resolve only trusted Docker-ID paths and prove direct PID membership before
// reading counters. The fallback also requires the target's cgroup identity.
const ownedIoScript = String.raw`
pid=$1
owner=$2
read_owned() {
 base=$1
 test -r "$base/cgroup.procs" && test -r "$base/io.stat" || return 1
 kind=$(stat -f -c %t "$base" 2>/dev/null) || return 1
 test "$kind" = 63677270 || return 1
 found=false
 while IFS= read -r task; do
  if test "$task" = "$pid"; then found=true; break; fi
 done < "$base/cgroup.procs"
 if test "$found" = true; then
  printf 'PARKBENCH_CGROUP_OWNER_CONFIRMED\n'
  cat "$base/io.stat" || exit 24
  return 0
 fi
 return 1
}
for base in "/proc/1/root/sys/fs/cgroup/docker/$owner" "/proc/1/root/sys/fs/cgroup/system.slice/docker-$owner.scope" "/proc/1/root/sys/fs/cgroup/$owner"; do
 if read_owned "$base"; then exit 0; fi
done
cg=""
read -r cg < "/proc/$pid/cgroup" || exit 25
case "$cg" in *"$owner"*) if read_owned "/proc/$pid/root/sys/fs/cgroup"; then exit 0; fi;; esac
printf 'PARKBENCH_CGROUP_OWNER_UNCONFIRMED\n'
`;
const defaultDocker = async (args) => {
  try {
    const { stdout } = await execFileAsync("docker", args, {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 262144,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return stdout.trim();
  } catch {
    // Docker errors can carry the complete stdout of a partial inspection.
    // Never let private container configuration escape as an Error property.
    throw Error("device_reader_command_unavailable");
  }
};
export async function captureDeviceState(runId, options = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(runId ?? "")) throw Error("device_reader_run_invalid");
  const docker = options.docker ?? defaultDocker,
    fetch = options.fetch ?? globalThis.fetch;
  const origin = new URL(options.cadvisorUrl ?? "http://127.0.0.1:18080");
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw Error("device_reader_origin_invalid");
  const discoveryStartedAtMs = Date.now();
  let cadvisor, targets;
  try {
    const ids = (await docker(["ps", "-q", "--filter", "label=parkbench.run_id=" + runId]))
      .split(/\s+/)
      .filter(Boolean);
    const platform = (
      await docker(["ps", "-q", "--filter", "label=com.docker.compose.project=parkbench-platform"])
    )
      .split(/\s+/)
      .filter(Boolean);
    if (!platform.length) throw Error("device_reader_platform_missing");
    const all = JSON.parse(await docker(["inspect", ...new Set([...ids, ...platform])]));
    cadvisor = all.find(
      (i) =>
        i.Config.Labels["com.docker.compose.project"] === "parkbench-platform" &&
        i.Config.Labels["com.docker.compose.service"] === "cadvisor"
    );
    if (!cadvisor) throw Error("device_reader_cadvisor_missing");
    targets = all.filter(
      (i) =>
        (i.Config.Labels["parkbench.run_id"] === runId &&
          ["database", "pas-1"].includes(i.Config.Labels["com.docker.compose.service"])) ||
        (i.Config.Labels["com.docker.compose.project"] === "parkbench-platform" &&
          platformServices.has(i.Config.Labels["com.docker.compose.service"]))
    );
  } catch {
    return [
      {
        runId,
        containerId: "unresolved",
        service: "discovery",
        readStartedAtMs: discoveryStartedAtMs,
        readFinishedAtMs: Date.now(),
        state: "UNAVAILABLE",
        reasonCode: "container_inventory_unavailable"
      }
    ];
  }
  const capture = async (target) => {
    const readStartedAtMs = Date.now(),
      record = {
        runId,
        containerId: target.Id,
        service: target.Config.Labels["com.docker.compose.service"],
        imageId: target.Image,
        readStartedAtMs
      };
    try {
      if (
        !/^[a-f0-9]{64}$/.test(target.Id) ||
        target.State.Status !== "running" ||
        !Number.isSafeInteger(target.State.Pid) ||
        target.State.Pid < 1
      )
        throw Error("not_running");
      const lines = (
        await docker([
          "exec",
          cadvisor.Id,
          "sh",
          "-c",
          ownedIoScript,
          "owned-io-reader",
          String(target.State.Pid),
          target.Id
        ])
      ).split(/\r?\n/);
      record.kernelOwnerConfirmed = lines[0] === "PARKBENCH_CGROUP_OWNER_CONFIRMED";
      record.kernelDevices = lines
        .filter((line) => /^\d+:\d+\s/.test(line))
        .map((line) => {
          const [majorMinor, ...fields] = line.trim().split(/\s+/),
            counters = fields.map((f) => f.split("="));
          if (
            !counters.every(
              ([key, value]) =>
                ["rbytes", "wbytes", "rios", "wios", "dbytes", "dios"].includes(key) &&
                /^\d+$/.test(value)
            )
          )
            throw Error("kernel_shape");
          return {
            majorMinor,
            counterKeys: counters.map(([key]) => key),
            nonzeroCounters: counters
              .filter(([, value]) => BigInt(value) !== 0n)
              .map(([key]) => key)
          };
        });
      const response = await fetch(
        `${origin.origin}/api/v2.0/stats/${target.Id}?type=docker&count=1`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) throw Error("api_unavailable");
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 ** 2) throw Error("api_limit");
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString()),
        frame = payload["/docker/" + target.Id]?.[0];
      if (
        !frame ||
        typeof frame.has_diskio !== "boolean" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(frame.timestamp ?? "") ||
        !Number.isFinite(Date.parse(frame.timestamp))
      )
        throw Error("api_shape");
      record.cadvisor = {
        capturedAt: frame.timestamp,
        hasDiskIo: frame.has_diskio,
        deviceFamilies: {}
      };
      for (const family of ["io_service_bytes", "io_serviced"]) {
        const devices = frame.diskio?.[family] ?? [];
        if (!Array.isArray(devices)) throw Error("api_shape");
        record.cadvisor.deviceFamilies[family] = devices.map((d) => {
          if (
            !Number.isSafeInteger(d.major) ||
            d.major < 0 ||
            !Number.isSafeInteger(d.minor) ||
            d.minor < 0 ||
            (d.device !== undefined &&
              (typeof d.device !== "string" ||
                d.device.length > 256 ||
                !/^((\/dev\/)[a-zA-Z0-9._/+:-]+)?$/.test(d.device))) ||
            !d.stats ||
            !Object.entries(d.stats).every(
              ([key, value]) =>
                ["Read", "Write", "Sync", "Async", "Total", "Discard"].includes(key) &&
                Number.isFinite(value) &&
                value >= 0
            )
          )
            throw Error("api_shape");
          return {
            majorMinor: `${d.major}:${d.minor}`,
            device: d.device,
            counterKeys: Object.keys(d.stats),
            nonzeroCounters: Object.entries(d.stats)
              .filter(([, value]) => value !== 0)
              .map(([key]) => key)
          };
        });
      }
      if (
        record.kernelDevices.length > 64 ||
        Object.values(record.cadvisor.deviceFamilies).some((rows) => rows.length > 64)
      )
        throw Error("inventory_limit");
      record.state = record.kernelOwnerConfirmed ? "COMPLETE" : "OWNER_UNCONFIRMED";
    } catch (error) {
      record.state = "UNAVAILABLE";
      record.reasonCode = [
        "not_running",
        "kernel_shape",
        "api_unavailable",
        "api_limit",
        "api_shape",
        "inventory_limit"
      ].includes(error.message)
        ? error.message
        : "read_unavailable";
    }
    record.readFinishedAtMs = Date.now();
    if (Buffer.byteLength(JSON.stringify(record)) > 4096)
      return {
        runId,
        containerId: target.Id,
        service: record.service,
        readStartedAtMs,
        readFinishedAtMs: Date.now(),
        state: "UNAVAILABLE",
        reasonCode: "event_limit"
      };
    return record;
  };
  // Bound independent kernel/native reads without multiplying discovery or
  // serialising every platform member behind the slowest target.
  const records = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= targets.length) return;
      records[index] = await capture(targets[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, worker));
  return records;
}

export async function main(args = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--run-id", "--output"].includes(args[i]) || args[i + 1] === undefined)
      throw Error("device_reader_arguments");
    flags[args[i].slice(2)] = args[i + 1];
  }
  const runId = flags["run-id"];
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(runId ?? "")) throw Error("device_reader_run_invalid");
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    root = path.join(repository, ".parkbench/validation/feature024");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await fs.realpath(root)) !== root) throw Error("device_reader_root_invalid");
  const file = flags.output
    ? path.resolve(flags.output)
    : path.join(root, "confirmation-kernel-" + runId + ".jsonl");
  if (
    !file.startsWith(root + path.sep) ||
    !file.endsWith(".jsonl") ||
    (await fs.realpath(path.dirname(file))) !== path.dirname(file)
  )
    throw Error("device_reader_output_invalid");
  const client = new CampaignClient(),
    initial = await client.get("/api/v1/history/runs/" + runId);
  if (initial.run.cleanupStatus === "COMPLETE") throw Error("device_reader_run_already_terminal");
  const handle = await fs.open(file, "ax", 0o600);
  let bytes = 0,
    records = 0;
  try {
    for (;;) {
      const { run } = await client.get("/api/v1/history/runs/" + runId);
      for (const record of await captureDeviceState(runId)) {
        const line =
          JSON.stringify({
            contractVersion: "measurement-device-state.v1",
            phase: run.phase,
            ...record
          }) + "\n";
        bytes += Buffer.byteLength(line);
        if (bytes > 8 * 1024 ** 2 || ++records > 8192) throw Error("device_reader_output_limit");
        await handle.write(line);
      }
      if (run.cleanupStatus === "COMPLETE") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await handle.close();
  }
  return {
    runId,
    records,
    bytes,
    output: path.relative(root, file),
    interpretation:
      "Bounded identity and availability metadata only - no disk counter values or zero disk readings"
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error("device_reader_failed - retained metadata is incomplete evidence");
      process.exitCode = 2;
    });
