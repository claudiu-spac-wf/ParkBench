import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION } from "../../packages/contracts/src/openedge";

export function temporaryOpenEdgeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-openedge-"));
}

export function createOpenEdgeFixtureWorkloadRoot(): string {
  const root = temporaryOpenEdgeRoot();
  const workloadRoot = path.join(root, "Workloads");
  fs.cpSync(path.resolve("openedge/workloads/Workloads"), workloadRoot, { recursive: true });
  fs.cpSync(path.resolve("tests/fixtures/openedge/workloads/Workloads"), workloadRoot, {
    recursive: true
  });
  return workloadRoot;
}

export function imageReference(repository: string, tag: string): string {
  return `${repository}:${tag}`;
}

export function syntheticImageManifest(stage: "generic" | "final" = "generic"): any {
  const generic = {
    schemaVersion: "image-build.v2",
    imageStage: stage,
    parkBenchReady: stage === "final",
    ...(stage === "final" ? { totalBuildDurationMs: 100 } : {}),
    createdAt: new Date(0).toISOString(),
    db: {
      repository: "parkbench/openedge-db",
      tag: "test",
      reference: imageReference("parkbench/openedge-db", "test")
    },
    pasoe: {
      repository: "parkbench/openedge-pasoe",
      tag: "test",
      reference: imageReference("parkbench/openedge-pasoe", "test")
    },
    observer: {
      repository: "parkbench/openedge-observer",
      tag: "test",
      reference: imageReference("parkbench/openedge-observer", "test")
    },
    observerContract: {
      protocolVersion: OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION,
      tableCoverage: "all_tables",
      parameterCaptureVersion: "openedge-db-parameter-capture.v1"
    },
    jdk: {
      repository: "jdk",
      tag: "test",
      reference: imageReference("jdk", "test")
    },
    databaseName: "parkbench",
    ...(stage === "final"
      ? { compileSchema: { seed: "one_gb_lnx", databaseName: "parkbench" } }
      : {}),
    runnerArchive: {
      path: "archives/oepas1.zip",
      kind: "pasoe-runner-archive"
    },
    workloadRoot: "Workloads",
    buildDurationMs: 100,
    inputs: [],
    workloads:
      stage === "final"
        ? [
            {
              procName: "Workloads/ParkBench/bank_mix.p",
              compiled: true,
              signature: "INPUT SingleParam AS LONGCHAR",
              pathStatus: "canonical",
              contract: {
                path: "Workloads/ParkBench/bank_mix.contract.json"
              },
              imageReference: imageReference("parkbench/openedge-pasoe", "test")
            }
          ]
        : []
  };
  return generic;
}

export function openEdgeBuildArgs(
  stage: "generic" | "final" | "all",
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const value = (name: string, fallback: string): string => environment[name] ?? fallback;
  return [
    "scripts/openedge/build-images.mjs",
    "--progress-root",
    value("PARKBENCH_OPENEDGE_PROGRESS_ROOT", "../IMAGES"),
    "--license",
    value("PARKBENCH_OPENEDGE_LICENSE_PATH", "../progress.cfg"),
    "--db-image",
    value("PARKBENCH_OPENEDGE_DB_BASE_IMAGE", "progresssoftware/prgs-oedb:12.8.11_ent"),
    "--pasoe-image",
    value("PARKBENCH_OPENEDGE_PAS_BASE_IMAGE", "progresssoftware/prgs-pasoe:12.8.11"),
    "--jdk-image",
    value("PARKBENCH_OPENEDGE_JDK_IMAGE", ""),
    "--jdk-path",
    value("PARKBENCH_OPENEDGE_JDK_PATH", "/usr/lib/jvm"),
    "--workload-root",
    value("PARKBENCH_OPENEDGE_WORKLOAD_ROOT", "openedge/workloads/Workloads"),
    "--output-root",
    value("PARKBENCH_OPENEDGE_OUTPUT_ROOT", ".parkbench/openedge"),
    "--image-stage",
    stage
  ];
}

export function runOpenEdgeBuilder(
  stage: "generic" | "final" | "all",
  environment: NodeJS.ProcessEnv = process.env
): void {
  execFileSync(process.execPath, openEdgeBuildArgs(stage, environment), {
    stdio: "inherit",
    env: { ...process.env, ...environment }
  });
}

export async function waitForOpenEdgeHealth(baseUrl: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "health_unavailable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now())))
      });
      if (response.ok) return;
      lastError = `health_status:${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`openedge_health_timeout:${lastError}`);
}

export async function postOpenEdgeWork(
  baseUrl: string,
  procName: string,
  input: unknown,
  timeoutMs = 65_000
): Promise<{ status?: number; body?: any; elapsedMs: number; timedOut: boolean }> {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/work`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-parkbench-request": crypto.randomUUID() },
      body: JSON.stringify({ procName, input }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return {
      status: response.status,
      body,
      elapsedMs: performance.now() - started,
      timedOut: false
    };
  } catch (error) {
    const value = error as { name?: string; code?: string };
    const timedOut =
      value.name === "TimeoutError" ||
      value.name === "AbortError" ||
      value.code === "UND_ERR_ABORTED";
    if (!timedOut) throw error;
    return { elapsedMs: performance.now() - started, timedOut: true };
  }
}

export function dockerImageInspection(reference: string): any {
  return JSON.parse(
    execFileSync("docker", ["image", "inspect", reference], { encoding: "utf8" })
  )[0];
}

export function zipEntryNames(file: string): string[] {
  return zipEntries(file).map((entry) => entry.name);
}

export function zipEntry(file: string, name: string): Buffer | undefined {
  return zipEntries(file).find((entry) => entry.name === name)?.data;
}

function zipEntries(file: string): Array<{ name: string; data: Buffer }> {
  const archive = fs.readFileSync(file);
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error(`zip_end_record_missing:${file}`);
  const count = archive.readUInt16LE(end + 10);
  const centralOffset = archive.readUInt32LE(end + 16);
  const entries: Array<{ name: string; data: Buffer }> = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("zip_central_record_invalid");
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const method = archive.readUInt16LE(cursor + 10);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localOffset = archive.readUInt32LE(cursor + 42);
    if (method !== 0) throw new Error(`zip_compression_unsupported:${name}`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, data: archive.subarray(dataStart, dataStart + compressedSize) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
