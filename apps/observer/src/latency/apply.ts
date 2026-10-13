import { execFile } from "node:child_process";
import dns from "node:dns";
import net from "node:net";

/**
 * Database Latency tool (feature 016). It runs inside a `latency-<target>` sidecar that shares
 * the target container's network namespace and holds NET_ADMIN:
 *
 *   apply --delay-ms <N> --peers <svc>[,<svc>...]
 *     prio root qdisc whose priomap sends all ordinary traffic to band 1:2, a netem band 1:4
 *     delaying <N> ms, and one u32 filter per peer IP steering only packets to that peer into
 *     the netem band. Run on every PAS replica (peer: database) and on the database (peers: all
 *     PAS replicas), each direction is delayed by N ms, about 2N ms per round trip.
 *   probe --target <host>:<port> [--samples 5]
 *     median TCP connect time, one round trip per handshake.
 *
 * Each command prints one JSON line. Exit codes: 0 ok, 2 unsupported kernel, 1 other failure.
 */

export type CommandRunner = (
  file: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_UNSUPPORTED = 2;

const UNSUPPORTED =
  /Specified (?:qdisc|filter|classifier) kind is unknown|Unknown (?:qdisc|filter)|not supported|Operation not supported/i;

export function parseDelayMs(value: string | undefined): number {
  const delay = Number(value);
  if (!Number.isInteger(delay) || delay < 1 || delay > 1000) throw new Error("delay_ms_invalid");
  return delay;
}

export function prioArgs(device: string): string[] {
  return [
    "qdisc",
    "replace",
    "dev",
    device,
    "root",
    "handle",
    "1:",
    "prio",
    "bands",
    "4",
    "priomap",
    ...Array.from({ length: 16 }, () => "1")
  ];
}

export function netemArgs(device: string, delayMs: number): string[] {
  return [
    "qdisc",
    "replace",
    "dev",
    device,
    "parent",
    "1:4",
    "handle",
    "40:",
    "netem",
    "delay",
    `${delayMs}ms`
  ];
}

export function filterArgs(device: string, ip: string): string[] {
  return [
    "filter",
    "add",
    "dev",
    device,
    "parent",
    "1:0",
    "protocol",
    "ip",
    "prio",
    "1",
    "u32",
    "match",
    "ip",
    "dst",
    `${ip}/32`,
    "flowid",
    "1:4"
  ];
}

export function parseRouteDevice(output: string): string | undefined {
  return /\bdev\s+(\S+)/.exec(output)?.[1];
}

export function median(values: number[]): number {
  if (!values.length) throw new Error("probe_samples_empty");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function classifyFailure(detail: string): typeof EXIT_UNSUPPORTED | typeof EXIT_FAILED {
  return UNSUPPORTED.test(detail) ? EXIT_UNSUPPORTED : EXIT_FAILED;
}

export const defaultRunner: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(String(stderr || error.message)), { stdout, stderr }));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface ApplyResult {
  ok: boolean;
  service: string;
  device?: string;
  peers: Array<{ service: string; ip: string }>;
  qdisc?: string;
  filters?: string;
  error?: string;
  exitCode: number;
}

export async function applyLatency(options: {
  delayMs: number;
  peers: string[];
  service?: string;
  run?: CommandRunner;
  lookup?: (name: string) => Promise<string[]>;
}): Promise<ApplyResult> {
  const run = options.run ?? defaultRunner;
  const lookup =
    options.lookup ??
    (async (name: string) =>
      (await dns.promises.lookup(name, { family: 4, all: true })).map((entry) => entry.address));
  const service = options.service ?? process.env.PARKBENCH_LATENCY_TARGET ?? "unknown";
  const peers: Array<{ service: string; ip: string }> = [];
  try {
    for (const peer of options.peers)
      for (const ip of [...new Set(await lookup(peer))]) peers.push({ service: peer, ip });
    if (!peers.length) throw new Error("peers_unresolved");
    const device = parseRouteDevice((await run("ip", ["-o", "route", "get", peers[0].ip])).stdout);
    if (!device) throw new Error("route_device_unresolved");
    // Start from a clean root qdisc so a retried apply never stacks duplicate filters.
    await run("tc", ["qdisc", "del", "dev", device, "root"]).catch(() => undefined);
    await run("tc", prioArgs(device));
    await run("tc", netemArgs(device, options.delayMs));
    for (const peer of peers) await run("tc", filterArgs(device, peer.ip));
    const qdisc = (await run("tc", ["-s", "qdisc", "show", "dev", device])).stdout;
    const filters = (await run("tc", ["filter", "show", "dev", device])).stdout;
    if (!/netem/.test(qdisc) || !/delay\s+\d/.test(qdisc)) throw new Error("netem_qdisc_missing");
    return { ok: true, service, device, peers, qdisc, filters, exitCode: EXIT_OK };
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || error).trim();
    return { ok: false, service, peers, error: detail, exitCode: classifyFailure(detail) };
  }
}

export interface ProbeResult {
  ok: boolean;
  target: string;
  samplesMs: number[];
  medianMs?: number;
  error?: string;
  exitCode: number;
}

export function connectOnce(host: string, port: number, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("probe_connect_timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      clearTimeout(timer);
      socket.destroy();
      resolve(elapsedMs);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

export async function probeLatency(options: {
  target: string;
  samples?: number;
  connect?: (host: string, port: number) => Promise<number>;
  lookup?: (name: string) => Promise<string>;
}): Promise<ProbeResult> {
  const samples = options.samples ?? 5;
  const connect = options.connect ?? connectOnce;
  const lookup =
    options.lookup ??
    (async (name: string) => (await dns.promises.lookup(name, { family: 4 })).address);
  const separator = options.target.lastIndexOf(":");
  const host = options.target.slice(0, separator);
  const port = Number(options.target.slice(separator + 1));
  const samplesMs: number[] = [];
  try {
    if (separator < 1 || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("probe_target_invalid");
    if (!Number.isInteger(samples) || samples < 1 || samples > 50)
      throw new Error("probe_samples_invalid");
    // Resolve once and connect by IP: a per-sample DNS lookup through Docker's resolver adds
    // milliseconds of jitter that would hide a small added delay. The first connection only
    // warms the path and is not measured.
    const address = await lookup(host);
    await connect(address, port);
    for (let index = 0; index < samples; index += 1) samplesMs.push(await connect(address, port));
    return {
      ok: true,
      target: options.target,
      samplesMs,
      medianMs: median(samplesMs),
      exitCode: EXIT_OK
    };
  } catch (error: any) {
    return {
      ok: false,
      target: options.target,
      samplesMs,
      error: String(error?.message ?? error),
      exitCode: EXIT_FAILED
    };
  }
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  let result: ApplyResult | ProbeResult;
  if (command === "apply") {
    let delayMs: number;
    try {
      delayMs = parseDelayMs(option(rest, "--delay-ms"));
    } catch (error: any) {
      console.log(JSON.stringify({ ok: false, error: error.message }));
      return EXIT_FAILED;
    }
    const peers = (option(rest, "--peers") ?? "")
      .split(",")
      .map((peer) => peer.trim())
      .filter(Boolean);
    result = await applyLatency({ delayMs, peers, service: option(rest, "--service") });
  } else if (command === "probe") {
    result = await probeLatency({
      target: option(rest, "--target") ?? "",
      samples: option(rest, "--samples") ? Number(option(rest, "--samples")) : undefined
    });
  } else {
    console.log(JSON.stringify({ ok: false, error: "usage: apply|probe" }));
    return EXIT_FAILED;
  }
  const { exitCode, ...output } = result;
  console.log(JSON.stringify(output));
  return exitCode;
}

if (require.main === module)
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
