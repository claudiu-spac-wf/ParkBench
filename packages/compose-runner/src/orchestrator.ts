import {
  DatabaseRunControlsError,
  DatabaseRunControlsEvidence,
  validateDatabaseRunControlsEvidence
} from "./database-run-controls-evidence";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Scenario } from "../../contracts/src/scenario";
import { RunResource, selectOwnedResources } from "./resources";
import { ComposeBundle } from "./run-compose";
import { cleanupOwnedResources } from "./cleanup";
import {
  DATABASE_LATENCY_APPLY_FAILED,
  DATABASE_LATENCY_CONTRACT_VERSION,
  DATABASE_LATENCY_UNCONFIRMED,
  DATABASE_LATENCY_UNSUPPORTED,
  DatabaseLatencyEvidence,
  DatabaseLatencyTarget,
  latencyTolerance
} from "../../contracts/src/database-latency";

export interface DatabaseLatencyRequest {
  delayMs: number;
  pasServices: string[];
  databaseService: string;
  probePort: number;
}

/** A latency failure carrying whatever evidence was gathered before it. */
export class DatabaseLatencyError extends Error {
  constructor(
    readonly code: string,
    readonly evidence: Partial<DatabaseLatencyEvidence>
  ) {
    super(code);
  }
}

const execFileAsync = promisify(execFile);
interface SharedPathResolver {
  resolveHostPath(
    input: string,
    options?: { root?: string; allowedRoot?: string; requireExisting?: boolean }
  ): string;
  isPathWithin(candidate: string, root: string): boolean;
}

function sharedPathResolver(): SharedPathResolver {
  const require = createRequire(__filename);
  const candidates = [
    path.resolve(__dirname, "../../../../scripts/lib/resolve-paths.cjs"),
    path.resolve(__dirname, "../../../scripts/lib/resolve-paths.cjs")
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate) as SharedPathResolver;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("parkbench_path_resolver_not_found");
}

export function mapContainerPath(localPath: string, localRoot: string, hostRoot: string): string {
  if (!path.isAbsolute(localRoot) || !path.isAbsolute(hostRoot))
    throw new Error("docker_host_path_mapping_required");
  const resolver = sharedPathResolver();
  const root = resolver.resolveHostPath(localRoot, { root: process.cwd() });
  const candidate = path.isAbsolute(localPath) ? localPath : path.resolve(localRoot, localPath);
  const lexicalCandidate = path.resolve(candidate);
  const resolvedHostRoot = resolver.resolveHostPath(hostRoot, { root: process.cwd() });
  if (!resolver.isPathWithin(lexicalCandidate, path.resolve(localRoot)))
    return resolver.resolveHostPath(candidate, { root: process.cwd() });
  const resolvedPath = resolver.resolveHostPath(candidate, {
    root: process.cwd(),
    allowedRoot: root
  });
  return path.join(resolvedHostRoot, path.relative(root, resolvedPath));
}

export function dockerHostPath(localPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const localRoot = env.PARKBENCH_CONTAINER_PATH_ROOT;
  if (!localRoot) return localPath;
  // The seeds root is its own bind mount (it may be outside the data root, e.g. BenchmarkDb), so
  // paths under it map to the seeds root's host path rather than through the data root.
  const seedsLocalRoot = env.PARKBENCH_DISCOVERY_SEEDS_ROOT;
  const seedsHostRoot = env.PARKBENCH_DOCKER_HOST_SEEDS_ROOT;
  if (
    seedsLocalRoot &&
    seedsHostRoot &&
    path.isAbsolute(seedsLocalRoot) &&
    path.isAbsolute(seedsHostRoot) &&
    sharedPathResolver().isPathWithin(path.resolve(localPath), path.resolve(seedsLocalRoot))
  )
    return mapContainerPath(localPath, seedsLocalRoot, seedsHostRoot);
  const hostRoot = env.PARKBENCH_DOCKER_HOST_PATH_ROOT;
  if (!hostRoot || !path.isAbsolute(hostRoot)) throw new Error("docker_host_path_mapping_required");
  return mapContainerPath(localPath, localRoot, hostRoot);
}

export interface RunOrchestrator {
  provision(bundle: ComposeBundle, isCancelled?: () => boolean): Promise<RunResource[]>;
  waitForReady(
    bundle: ComposeBundle,
    scenario: Scenario,
    timeoutMs: number,
    isCancelled?: () => boolean
  ): Promise<void>;
  startWorkload(bundle: ComposeBundle): Promise<void>;
  /** Applies and confirms Database Latency in the run's latency sidecars (feature 016). */
  applyDatabaseLatency?(
    bundle: ComposeBundle,
    request: DatabaseLatencyRequest,
    isCancelled?: () => boolean
  ): Promise<DatabaseLatencyEvidence>;
  stopWorkload(bundle: ComposeBundle): Promise<void>;
  cleanup(bundle: ComposeBundle, resources: RunResource[]): Promise<RunResource[]>;
  waitForWorkload?(
    bundle: ComposeBundle,
    isCancelled?: () => boolean,
    maxWaitMs?: number
  ): Promise<number>;
  collectLogs?(bundle: ComposeBundle): Promise<string>;
  metadata(): Promise<Record<string, unknown>>;
  health?(): Promise<boolean>;
  checkDatabaseRunControls?(
    bundle: ComposeBundle,
    allowPending?: boolean
  ): Promise<DatabaseRunControlsEvidence | undefined>;
  inspectImage?(image: string): Promise<boolean>;
  inspectImageDetails?(image: string): Promise<Record<string, unknown> | undefined>;
  listLocalImages?(): Promise<Array<Record<string, unknown>>>;
}

export function classifyReadinessProbeStatus(status: number): "ready" | "failed" | "retry" {
  if (status >= 200 && status < 300) return "ready";
  if (status >= 400 && status < 500) return "failed";
  if (status >= 300 && status < 400) return "failed";
  return "retry";
}

export class DockerComposeOrchestrator implements RunOrchestrator {
  constructor(
    private readonly root = path.resolve(process.env.PARKBENCH_RUN_ROOT ?? ".parkbench/runs"),
    private readonly docker = "docker"
  ) {}

  async provision(bundle: ComposeBundle, isCancelled = () => false): Promise<RunResource[]> {
    if (isCancelled()) throw new Error("run_cancelled");
    this.validateDockerPaths(bundle);
    fs.mkdirSync(this.root, { recursive: true });
    const file = this.fileFor(bundle);
    fs.writeFileSync(
      path.join(this.root, `${bundle.projectName}-scenario.json`),
      JSON.stringify(bundle.scenario, null, 2)
    );
    if(bundle.brokerDirectories!==undefined)fs.writeFileSync(path.join(this.root,`${bundle.projectName}-broker-directories`),bundle.brokerDirectories,{mode:0o600});
    if(bundle.brokerArgv!==undefined)fs.writeFileSync(path.join(this.root,`${bundle.projectName}-broker.argv`),bundle.brokerArgv,{mode:0o600});
    if (bundle.summaryPath) {
      fs.mkdirSync(path.dirname(bundle.summaryPath), { recursive: true });
      if (!fs.existsSync(bundle.summaryPath)) fs.writeFileSync(bundle.summaryPath, "");
    }
    if (bundle.shutdownPath) {
      fs.mkdirSync(path.dirname(bundle.shutdownPath), { recursive: true });
      if (!fs.existsSync(bundle.shutdownPath)) fs.writeFileSync(bundle.shutdownPath, "");
    }
    if (bundle.workloadStartPath) {
      fs.mkdirSync(path.dirname(bundle.workloadStartPath), { recursive: true });
      if (!fs.existsSync(bundle.workloadStartPath)) fs.writeFileSync(bundle.workloadStartPath, "");
    }
    fs.writeFileSync(file, this.renderForDocker(bundle));
    await this.ensureExternalNetwork(bundle.metricsNetworkName);
    if (isCancelled()) throw new Error("run_cancelled");
    const services = bundle.resources
      .filter((resource) => resource.type === "container" && resource.name !== "loadgen")
      .map((resource) => resource.name);
    await this.command(["compose", "-p", bundle.projectName, "-f", file, "up", "-d", ...services]);
    await this.refreshObserverPorts(bundle, ["db-observer", "pas-observer", "file-sampler"]);
    return bundle.resources.map((resource) => ({
      resourceType: resource.type as RunResource["resourceType"],
      resourceId: resource.name,
      labels: resource.labels,
      createdAt: new Date().toISOString()
    }));
  }

  async waitForReady(
    bundle: ComposeBundle,
    scenario: Scenario,
    timeoutMs: number,
    isCancelled = () => false
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const required = [
      "database",
      ...Array.from({ length: scenario.target.pasReplicas }, (_, i) => `pas-${i + 1}`)
    ];
    let lastFailure = "compose_state";
    while (Date.now() < deadline) {
      if (isCancelled()) throw new Error("run_cancelled");
      const result = await this.command(
        // --all: an exited database or PAS container must fail readiness now, not at the timeout.
        [
          "compose",
          "-p",
          bundle.projectName,
          "-f",
          this.fileFor(bundle),
          "ps",
          "--all",
          "--format",
          "json"
        ],
        true
      );
      const rows = parseComposePs(result.stdout);
      const failedService = required.find((service) => {
        const row = rows.find(
          (candidate) => candidate.Service === service || candidate.Name?.includes(`-${service}-`)
        );
        return ["exited", "dead"].includes(String(row?.State ?? "").toLowerCase());
      });
      if (failedService) {
        if (failedService === "database" && bundle.databaseRunControls)
          await this.checkDatabaseRunControls(bundle);
        throw new Error(
          `${failedService === "database" ? "database" : "pas"}_readiness_failed:container_exited`
        );
      }
      const ready = required.every((service) => {
        const row = rows.find(
          (candidate) => candidate.Service === service || candidate.Name?.includes(`-${service}-`)
        );
        return row && ["running", "healthy"].includes(String(row.State ?? "").toLowerCase());
      });
      if (ready) {
        const probeRequests = [
          {
            service: "database",
            url: "http://127.0.0.1:9100/health"
          },
          ...Array.from({ length: scenario.target.pasReplicas }, (_, index) => ({
            service: `pas-${index + 1}`,
            url: `http://127.0.0.1:9100/health?replica=${index + 1}`
          })),
          ...Array.from({ length: scenario.target.pasReplicas }, (_, index) => ({
            service: `pas-${index + 1}`,
            url: `http://127.0.0.1:9100/application-health?replica=${index + 1}`
          }))
        ];
        const probes = await Promise.all(
          probeRequests.map(async (probe) => {
            const parsed = new URL(probe.url);
            return {
              ...probe,
              status: await this.probeFromObserver(
                bundle,
                probe.service,
                `${parsed.pathname}${parsed.search}`
              )
            };
          })
        );
        if (isCancelled()) throw new Error("run_cancelled");
        const failedProbe = probes.find((probe) => probe.status === "failed");
        if (failedProbe)
          throw new Error(
            `${failedProbe.service === "database" ? "database" : "pas"}_readiness_failed:${new URL(failedProbe.url).pathname}`
          );
        if (probes.every((probe) => probe.status === "ready")) {
          if (bundle.databaseRunControls && !(await this.checkDatabaseRunControls(bundle, true))) {
            lastFailure = "database_run_controls_pending";
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          if (!bundle.schemaReadinessProcedures?.length) return;
          const schemaResults = await Promise.all(
            Array.from({ length: scenario.target.pasReplicas }, (_, index) =>
              this.probeWorkloadSchema(bundle, index + 1)
            )
          );
          if (schemaResults.includes("invalid")) throw new Error("database_schema_invalid");
          if (schemaResults.includes("failed"))
            throw new Error("pas_readiness_failed:schema_route");
          if (schemaResults.every((result) => result === "ready")) return;
          lastFailure = "database_schema_readiness";
        } else {
          lastFailure = probes
            .filter((probe) => probe.status === "retry")
            .map((probe) => `${probe.service}:${new URL(probe.url).pathname}`)
            .join(",");
        }
      } else {
        lastFailure =
          required
            .filter((service) => {
              const row = rows.find(
                (candidate) =>
                  candidate.Service === service || candidate.Name?.includes(`-${service}-`)
              );
              return (
                !row || !["running", "healthy"].includes(String(row.State ?? "").toLowerCase())
              );
            })
            .join(",") || "database_or_pas_container_state";
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`run_readiness_timeout:${lastFailure}`);
  }

  async checkDatabaseRunControls(
    bundle: ComposeBundle,
    allowPending = false
  ): Promise<DatabaseRunControlsEvidence | undefined> {
    if (!bundle.databaseRunControls || !bundle.databaseName) return undefined;
    const result = await this.command(
      [
        "compose",
        "-p",
        bundle.projectName,
        "-f",
        this.fileFor(bundle),
        "ps",
        "--all",
        "-q",
        "database"
      ],
      true
    );
    const id = result.stdout.trim();
    if (!/^[a-f0-9]{12,64}$/.test(id))
      throw new DatabaseRunControlsError("database_run_control_unapplied");
    const labelsResult = await this.command(["inspect", "--format", "{{json .Config.Labels}}", id]);
    const labels = JSON.parse(labelsResult.stdout);
    const expected = bundle.resources.find((r) => r.name === "database")?.labels;
    if (
      !expected ||
      labels["parkbench.run_id"] !== expected["parkbench.run_id"] ||
      labels["parkbench.component"] !== "database"
    )
      throw new DatabaseRunControlsError("database_run_control_unapplied");
    const directory = path.join(this.root, bundle.projectName + "-database-evidence");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "database-run-controls.json");
    fs.rmSync(file, { force: true });
    await this.command(
      ["cp", `${id}:/psc/wrk/${bundle.databaseName}/database-run-controls.json`, file],
      true
    );
    if (!fs.existsSync(file)) {
      const preparationFile = path.join(directory, "preparation.json");
      fs.rmSync(preparationFile, { force: true });
      await this.command(
        ["cp", `${id}:/psc/wrk/${bundle.databaseName}/preparation.json`, preparationFile],
        true
      );
      if (fs.existsSync(preparationFile) && fs.statSync(preparationFile).size <= 8192) {
        const preparation = JSON.parse(fs.readFileSync(preparationFile, "utf8"));
        if (preparation.status === "failed")
          throw new DatabaseRunControlsError("database_bi_preparation_failed", {
            contractVersion: "db-run-controls-evidence.v1",
            capturedAt: new Date().toISOString(),
            verification: "unavailable",
            writerHealth: "unavailable",
            reason: "database_bi_preparation_failed",
            preparation
          });
      }
      if (allowPending) return undefined;
      throw new DatabaseRunControlsError("database_run_control_unapplied");
    }
    if (fs.statSync(file).size > 131072)
      throw new DatabaseRunControlsError("database_run_control_unapplied");
    let evidence: DatabaseRunControlsEvidence;
    try {
      evidence = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new DatabaseRunControlsError("database_run_control_unapplied");
    }
    try {
      validateDatabaseRunControlsEvidence(
        evidence,
        bundle.databaseRunControls,
        bundle.expectedBiBuffers,
        bundle.databaseRunControlEvidence
      );
    } catch (error) {
      bundle.databaseRunControlEvidence = evidence;
      throw error;
    }
    bundle.databaseRunControlEvidence = evidence;
    return evidence;
  }

  private async probeFromObserver(
    bundle: ComposeBundle,
    targetService: string,
    pathWithQuery: string
  ): Promise<"ready" | "failed" | "retry"> {
    const observerService = targetService === "database" ? "db-observer" : "pas-observer";
    const target = `http://127.0.0.1:9100${pathWithQuery}`;
    const script = `try { const response = await fetch(${JSON.stringify(target)}); const body = await response.text(); console.log(body.startsWith("named_latch_evidence_missing:") ? "named_latch_evidence_missing" : response.status); } catch { console.log(0); }`;
    try {
      const result = await this.command(
        [
          "compose",
          "-p",
          bundle.projectName,
          "-f",
          this.fileFor(bundle),
          "exec",
          "-T",
          observerService,
          "node",
          "--input-type=module",
          "-e",
          script
        ],
        true
      );
      const last = result.stdout.trim().split(/\r?\n/).at(-1);
      if (
        last === "named_latch_evidence_missing" &&
        targetService === "database" &&
        bundle.databaseRunControls?.requirements?.namedLatchRequired
      )
        throw new Error("named_latch_evidence_missing:collector_contract");
      return classifyReadinessProbeStatus(Number(last));
    } catch (error) {
      if (String(error).includes("named_latch_evidence_missing")) throw error;
      return "retry";
    }
  }

  /** Runs every contract-validated workload's `validate` mode on one PAS replica. */
  private async probeWorkloadSchema(
    bundle: ComposeBundle,
    replica: number
  ): Promise<"ready" | "invalid" | "failed" | "retry"> {
    const script = `try { const response = await fetch("http://127.0.0.1:9100/schema-readiness?replica=${replica}"); const body = await response.text(); console.log(response.status === 422 && body.trim() === "database_schema_invalid" ? "invalid" : response.ok ? "ready" : response.status >= 400 && response.status < 500 ? "failed" : "retry"); } catch { console.log("retry"); }`;
    const result = await this.command(
      [
        "compose",
        "-p",
        bundle.projectName,
        "-f",
        this.fileFor(bundle),
        "exec",
        "-T",
        "pas-observer",
        "node",
        "--input-type=module",
        "-e",
        script
      ],
      true
    );
    const state = result.stdout.trim().split(/\r?\n/).at(-1);
    return state === "ready" || state === "invalid" || state === "failed" ? state : "retry";
  }

  async startWorkload(bundle: ComposeBundle): Promise<void> {
    await this.command([
      "compose",
      "-p",
      bundle.projectName,
      "-f",
      this.fileFor(bundle),
      "up",
      "-d",
      "loadgen"
    ]);
    await this.refreshObserverPorts(bundle, ["loadgen"]);
  }

  async applyDatabaseLatency(
    bundle: ComposeBundle,
    request: DatabaseLatencyRequest,
    isCancelled = () => false
  ): Promise<DatabaseLatencyEvidence> {
    const startedAt = Date.now();
    const probeService = `latency-${request.pasServices[0]}`;
    const probeTarget = `${request.databaseService}:${request.probePort}`;
    const targets: DatabaseLatencyTarget[] = [];
    const evidence = (): Partial<DatabaseLatencyEvidence> => ({ targets: [...targets] });
    const tool = async (service: string, args: string[]) => {
      if (isCancelled()) throw new Error("run_cancelled");
      const result = await this.command(
        [
          "compose",
          "-p",
          bundle.projectName,
          "-f",
          this.fileFor(bundle),
          "exec",
          "-T",
          service,
          "node",
          "dist/apps/observer/src/latency/apply.js",
          ...args
        ],
        true
      );
      let parsed: any;
      try {
        parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "");
      } catch {
        parsed = { ok: false, error: result.stderr.trim() || "latency_tool_output_invalid" };
      }
      return parsed;
    };
    const probe = async () => {
      const result = await tool(probeService, ["probe", "--target", probeTarget, "--samples", "5"]);
      if (!result.ok)
        throw new DatabaseLatencyError(
          `${DATABASE_LATENCY_APPLY_FAILED}:${request.pasServices[0]}`,
          evidence()
        );
      return Number(result.medianMs);
    };
    const apply = async (target: string, peers: string[]) => {
      const result = await tool(`latency-${target}`, [
        "apply",
        "--delay-ms",
        String(request.delayMs),
        "--peers",
        peers.join(","),
        "--service",
        target
      ]);
      if (!result.ok) {
        const unsupported =
          /Specified (?:qdisc|filter|classifier) kind is unknown|Unknown (?:qdisc|filter)|not supported/i.test(
            String(result.error ?? "")
          );
        throw new DatabaseLatencyError(
          unsupported ? DATABASE_LATENCY_UNSUPPORTED : `${DATABASE_LATENCY_APPLY_FAILED}:${target}`,
          evidence()
        );
      }
      targets.push({
        service: target,
        device: String(result.device),
        peers: result.peers ?? [],
        qdisc: String(result.qdisc ?? ""),
        filters: String(result.filters ?? "")
      });
    };
    const baselineRttMs = await probe();
    await apply(request.databaseService, request.pasServices);
    for (const pas of request.pasServices) await apply(pas, [request.databaseService]);
    const measuredRttMs = await probe();
    const toleranceMs = latencyTolerance(request.delayMs);
    const probeEvidence = {
      from: request.pasServices[0],
      to: probeTarget,
      samples: 5,
      baselineRttMs,
      measuredRttMs,
      expectedDeltaMs: 2 * request.delayMs,
      toleranceMs
    };
    const delta = measuredRttMs - baselineRttMs;
    if (!(delta >= toleranceMs.min && delta <= toleranceMs.max))
      throw new DatabaseLatencyError(DATABASE_LATENCY_UNCONFIRMED, {
        ...evidence(),
        probe: probeEvidence
      });
    return {
      contractVersion: DATABASE_LATENCY_CONTRACT_VERSION,
      requestedMs: request.delayMs,
      appliedMs: request.delayMs,
      mode: "netem",
      status: "confirmed",
      targets,
      probe: probeEvidence,
      applyDurationMs: Date.now() - startedAt,
      appliedAt: new Date().toISOString()
    };
  }

  async stopWorkload(bundle: ComposeBundle): Promise<void> {
    await this.command([
      "compose",
      "-p",
      bundle.projectName,
      "-f",
      this.fileFor(bundle),
      "stop",
      "loadgen"
    ]);
  }

  async waitForWorkload(
    bundle: ComposeBundle,
    isCancelled?: () => boolean,
    maxWaitMs?: number
  ): Promise<number> {
    if (isCancelled || maxWaitMs !== undefined)
      return this.waitForWorkloadWithCancellation(bundle, isCancelled ?? (() => false), maxWaitMs);
    try {
      const result = await this.command(
        ["compose", "-p", bundle.projectName, "-f", this.fileFor(bundle), "wait", "loadgen"],
        true
      );
      const code = Number(result.stdout.trim());
      return Number.isInteger(code) ? code : 0;
    } catch (error: any) {
      return typeof error?.code === "number" ? error.code : 50;
    }
  }

  private async waitForWorkloadWithCancellation(
    bundle: ComposeBundle,
    isCancelled: () => boolean,
    maxWaitMs?: number
  ): Promise<number> {
    const deadline = maxWaitMs === undefined ? Infinity : Date.now() + maxWaitMs;
    while (true) {
      if (isCancelled()) {
        await this.stopWorkload(bundle);
        return 10;
      }
      if (Date.now() >= deadline) {
        await this.stopWorkload(bundle);
        return 124;
      }
      const result = await this.command(
        [
          "compose",
          "-p",
          bundle.projectName,
          "-f",
          this.fileFor(bundle),
          "ps",
          "--all",
          "--format",
          "json",
          "loadgen"
        ],
        true
      );
      if (result.stderr.trim()) return 50;
      const row = parseComposePs(result.stdout).find(
        (candidate) => candidate.Service === "loadgen" || candidate.Name?.includes("-loadgen-")
      );
      const state = String(row?.State ?? "").toLowerCase();
      if (row && ["exited", "stopped", "dead"].includes(state)) {
        const code = Number(row.ExitCode ?? 0);
        return Number.isInteger(code) ? code : 50;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async collectLogs(bundle: ComposeBundle): Promise<string> {
    const result = await this.command(
      ["compose", "-p", bundle.projectName, "-f", this.fileFor(bundle), "logs", "--no-color"],
      true
    );
    const parts = [result.stdout, result.stderr];
    if (!bundle.databaseRunControls || !bundle.databaseName) return parts.join("\n");
    // docker cp also works after native startup/health failures stop the database container.
    // Capture before cleanup, and never follow a container belonging to another run.
    try {
      const container = await this.command(
        [
          "compose",
          "-p",
          bundle.projectName,
          "-f",
          this.fileFor(bundle),
          "ps",
          "--all",
          "-q",
          "database"
        ],
        true
      );
      const id = container.stdout.trim();
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("container_unavailable");
      const inspected = await this.command(["inspect", "--format", "{{json .Config.Labels}}", id]);
      const labels = JSON.parse(inspected.stdout);
      const expected = bundle.resources.find((resource) => resource.name === "database")?.labels;
      if (
        !expected ||
        labels["parkbench.run_id"] !== expected["parkbench.run_id"] ||
        labels["parkbench.component"] !== "database"
      )
        throw new Error("ownership_mismatch");
      const directory = path.join(this.root, bundle.projectName + "-database-evidence");
      fs.mkdirSync(directory, { recursive: true });
      for (const name of ["startup-state.log", "writer-start.log", "bi-preparation.log"]) {
        const file = path.join(directory, name);
        fs.rmSync(file, { force: true });
        await this.command(["cp", `${id}:/psc/wrk/${bundle.databaseName}/${name}`, file], true);
        if (!fs.existsSync(file)) continue;
        const size = fs.statSync(file).size;
        const tail = Buffer.alloc(Math.min(size, 65536));
        const descriptor = fs.openSync(file, "r");
        try {
          fs.readSync(descriptor, tail, 0, tail.length, Math.max(0, size - tail.length));
        } finally {
          fs.closeSync(descriptor);
        }
        fs.writeFileSync(file, tail);
        parts.push(
          `database native ${name}${size > tail.length ? " (last 65536 bytes)" : ""}:\n${tail.toString("utf8")}`
        );
      }
    } catch (error) {
      parts.push(
        `database_native_logs_unavailable:${error instanceof Error ? error.message : "capture_failed"}`
      );
    }
    return parts.join("\n");
  }

  async cleanup(bundle: ComposeBundle, resources: RunResource[]): Promise<RunResource[]> {
    let downError: string | undefined;
    const runId = bundle.resources[0]?.labels["parkbench.run_id"] ?? "";
    const owned = selectOwnedResources(resources, runId);
    const ownership = await Promise.all(
      owned.map(async (resource) => ({
        resource,
        verified: await this.resourceOwnershipVerified(bundle, resource, runId)
      }))
    );
    const ownershipFailures = ownership.filter((item) => !item.verified);
    if (ownershipFailures.length) {
      return owned.map((resource) => ({
        ...resource,
        cleanupResult: `ownership_verification_failed:${resource.resourceType}:${resource.resourceId}`
      }));
    }
    try {
      await this.command([
        "compose",
        "-p",
        bundle.projectName,
        "-f",
        this.fileFor(bundle),
        "down",
        "--volumes",
        "--remove-orphans"
      ]);
    } catch (error) {
      downError = String(error);
    }
    let generatedFilesError: string | undefined;
    try {
      fs.rmSync(this.fileFor(bundle), { force: true });
      fs.rmSync(path.join(this.root, `${bundle.projectName}-scenario.json`), { force: true });
      fs.rmSync(path.join(this.root, `${bundle.projectName}-broker.argv`), { force: true });
      fs.rmSync(path.join(this.root, `${bundle.projectName}-broker-directories`), { force: true });
      if (bundle.shutdownPath) fs.rmSync(bundle.shutdownPath, { force: true });
      if (bundle.workloadStartPath) fs.rmSync(bundle.workloadStartPath, { force: true });
    } catch (error) {
      generatedFilesError = `generated_file_cleanup_failed:${String(error)}`;
    }
    if (
      !generatedFilesError &&
      [
        this.fileFor(bundle),
        path.join(this.root, `${bundle.projectName}-scenario.json`),
        path.join(this.root, `${bundle.projectName}-broker.argv`),
        path.join(this.root, `${bundle.projectName}-broker-directories`),
        bundle.shutdownPath,
        bundle.workloadStartPath
      ]
        .filter((file): file is string => Boolean(file))
        .some((file) => fs.existsSync(file))
    )
      generatedFilesError = "generated_file_cleanup_verification_failed";
    const verified = await Promise.all(
      owned.map(async (resource) => {
        const gone = await this.resourceGone(bundle, resource);
        return gone
          ? {
              ...resource,
              deletedAt: new Date().toISOString(),
              cleanupResult: downError
                ? `deleted_with_compose_down_error:${downError}`
                : generatedFilesError && resource.resourceType === "compose_project"
                  ? generatedFilesError
                  : "deleted"
            }
          : {
              ...resource,
              deletedAt: undefined,
              cleanupResult: downError
                ? `compose_down_failed:${downError}`
                : generatedFilesError && resource.resourceType === "compose_project"
                  ? generatedFilesError
                  : `cleanup_verification_failed:${resource.resourceId}`
            };
      })
    );
    return verified;
  }

  async metadata(): Promise<Record<string, unknown>> {
    const version = await this.command(["version", "--format", "{{json .}}"], true);
    let engine = {
      reachable: false,
      contextName: null as string | null,
      serverVersion: null as string | null,
      operatingSystem: null as string | null,
      architecture: null as string | null
    };
    try {
      const info = await this.command(
        ["info", "--format", "{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}"],
        true
      );
      const [serverVersion, operatingSystem, architecture] = info.stdout.trim().split("|");
      engine = {
        reachable: Boolean(serverVersion),
        contextName: null,
        serverVersion: safeMetadataValue(serverVersion),
        operatingSystem: safeMetadataValue(operatingSystem)?.toLowerCase() ?? null,
        architecture: normalizeDockerArchitecture(architecture)
      };
    } catch {
      // Keep the rest of the observed CLI metadata when the Engine query is unavailable.
    }
    const hostEnvironment = readHostEnvironmentEvidence(engine);
    return {
      docker: version.stdout.trim(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      engine,
      ...(hostEnvironment ? { hostEnvironment } : {})
    };
  }

  async health(): Promise<boolean> {
    try {
      await this.command(["info"], false);
      return true;
    } catch {
      return false;
    }
  }

  async inspectImage(image: string): Promise<boolean> {
    try {
      await this.command(["image", "inspect", image], false);
      return true;
    } catch {
      return false;
    }
  }

  async inspectImageDetails(image: string): Promise<Record<string, unknown> | undefined> {
    try {
      const result = await this.command(["image", "inspect", "--format", "{{json .}}", image]);
      return JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
  }

  async listLocalImages(): Promise<Array<Record<string, unknown>>> {
    try {
      const result = await this.command(
        ["image", "ls", "--no-trunc", "--format", "{{json .}}"],
        true
      );
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line);
            return parsed && typeof parsed === "object" ? [parsed] : [];
          } catch {
            return [];
          }
        });
    } catch {
      throw new Error("docker_discovery_unavailable");
    }
  }

  private fileFor(bundle: ComposeBundle): string {
    return path.join(this.root, `${bundle.projectName}.yml`);
  }

  private renderForDocker(bundle: ComposeBundle): string {
    const scenarioFile = `${bundle.projectName}-scenario.json`;
    let rendered = bundle.file.replaceAll(
      `./${scenarioFile}`,
      yamlEscape(this.dockerPath(path.join(this.root, scenarioFile)))
    );
    rendered=rendered.replaceAll(`./${bundle.projectName}-broker.argv`,yamlEscape(this.dockerPath(path.join(this.root,`${bundle.projectName}-broker.argv`))));
    rendered=rendered.replaceAll(`./${bundle.projectName}-broker-directories`,yamlEscape(this.dockerPath(path.join(this.root,`${bundle.projectName}-broker-directories`))));
    for (const localPath of [
      ...bundle.localPaths,
      bundle.summaryPath,
      bundle.shutdownPath,
      bundle.workloadStartPath
    ]) {
      if (!localPath) continue;
      rendered = rendered.replaceAll(
        `${yamlEscape(localPath)}:`,
        `${yamlEscape(this.dockerPath(localPath))}:`
      );
    }
    return rendered;
  }

  private dockerPath(localPath: string): string {
    return dockerHostPath(localPath);
  }

  private validateDockerPaths(bundle: ComposeBundle): void {
    const paths = [
      path.join(this.root, `${bundle.projectName}.yml`),
      path.join(this.root, `${bundle.projectName}-scenario.json`),
      ...bundle.localPaths,
      bundle.summaryPath,
      bundle.shutdownPath,
      bundle.workloadStartPath
    ];
    for (const value of paths) if (value) dockerHostPath(value);
  }

  private async ensureExternalNetwork(name: string): Promise<void> {
    const inspected = await this.command(["network", "inspect", name], true);
    if (inspected.stdout.trim()) return;
    await this.command([
      "network",
      "create",
      "--label",
      "parkbench.managed=true",
      "--label",
      "parkbench.network=metrics",
      name
    ]);
  }

  private async refreshObserverPorts(bundle: ComposeBundle, services: string[]): Promise<void> {
    const file = this.fileFor(bundle);
    bundle.observerPorts ??= {};
    for (const service of services) {
      let port: number | undefined;
      for (let attempt = 0; attempt < 20 && port === undefined; attempt++) {
        const result = await this.command(
          ["compose", "-p", bundle.projectName, "-f", file, "port", service, "9100"],
          true
        );
        port = parsePublishedPort(result.stdout);
        if (port === undefined && attempt < 19)
          await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (port === undefined) throw new Error(`observer_host_port_unavailable:${service}`);
      bundle.observerPorts[service] = port;
    }
  }

  private async resourceGone(bundle: ComposeBundle, resource: RunResource): Promise<boolean> {
    if (resource.resourceType === "temporary_directory") return !fs.existsSync(resource.resourceId);
    if (resource.resourceType === "target_file") {
      if (!fs.existsSync(resource.resourceId)) return true;
      try {
        const targets = JSON.parse(fs.readFileSync(resource.resourceId, "utf8")) as Array<{
          labels?: Record<string, string>;
        }>;
        return !targets.some(
          (target) => target.labels?.run_id === resource.labels["parkbench.run_id"]
        );
      } catch {
        return false;
      }
    }
    const id =
      resource.resourceType === "container"
        ? `${bundle.projectName}-${resource.resourceId}-1`
        : resource.resourceId;
    const type = resource.resourceType === "compose_project" ? "compose" : resource.resourceType;
    const args =
      type === "compose"
        ? ["compose", "ls", "--all", "--format", "json"]
        : [type === "container" ? "container" : type, "inspect", id];
    const result = await this.command(args, true);
    if (type === "compose") {
      const rows = parseComposePs(result.stdout);
      return !rows.some(
        (row) => row.Name === bundle.projectName || row.name === bundle.projectName
      );
    }
    const output = result.stdout.trim();
    if (output === "[]" || !output)
      return /no such|not found|does not exist/i.test(result.stderr) || !result.stderr.trim();
    return false;
  }

  private async resourceOwnershipVerified(
    bundle: ComposeBundle,
    resource: RunResource,
    runId: string
  ): Promise<boolean> {
    if (resource.resourceType === "temporary_directory" || resource.resourceType === "target_file")
      return resource.labels["parkbench.run_id"] === runId;
    if (resource.resourceType === "compose_project") {
      const result = await this.command(["compose", "ls", "--all", "--format", "json"], true);
      return !result.stderr.trim();
    }
    const type = resource.resourceType === "container" ? "container" : resource.resourceType;
    const id =
      resource.resourceType === "container"
        ? `${bundle.projectName}-${resource.resourceId}-1`
        : resource.resourceId;
    const result = await this.command([type, "inspect", id], true);
    if (!result.stdout.trim() || result.stdout.trim() === "[]")
      return /no such|not found|does not exist/i.test(result.stderr);
    try {
      const parsed = JSON.parse(result.stdout);
      const inspected = Array.isArray(parsed) ? parsed[0] : parsed;
      const labels = inspected?.Config?.Labels ?? inspected?.Labels ?? {};
      return (
        labels["parkbench.managed"] === "true" &&
        labels["parkbench.run_id"] === runId &&
        labels["parkbench.experiment_id"] === resource.labels["parkbench.experiment_id"]
      );
    } catch {
      return false;
    }
  }

  private async command(
    args: string[],
    tolerateFailure = false
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(this.docker, args, { maxBuffer: 4 * 1024 * 1024 });
    } catch (error: any) {
      if (tolerateFailure)
        return { stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error) };
      throw new Error(`docker_command_failed:${args.join(" ")}:${String(error?.stderr ?? error)}`);
    }
  }
}

function yamlEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parseComposePs(output: string): Array<Record<string, any>> {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      });
  }
}

function readHostEnvironmentEvidence(
  observedEngine: Record<string, string | boolean | null>
): Record<string, unknown> | undefined {
  const configuredRoot =
    process.env.PARKBENCH_CONTAINER_PATH_ROOT ||
    process.env.PARKBENCH_HOST_DATA_ROOT ||
    ".parkbench";
  const root = path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.resolve(process.env.PARKBENCH_REPOSITORY_ROOT || process.cwd(), configuredRoot);
  const profilePath = path.join(root, "host-environment.json");
  try {
    const contents = fs.readFileSync(profilePath);
    const profile = JSON.parse(contents.toString("utf8"));
    if (profile.contractVersion !== "host-environment.v1" || !validUtcTimestamp(profile.capturedAt))
      return undefined;
    const profileEngine = profile.engine ?? {};
    const engine = {
      reachable: observedEngine.reachable === true || profileEngine.reachable === true,
      contextName: null,
      serverVersion: observedEngine.serverVersion ?? safeMetadataValue(profileEngine.serverVersion),
      operatingSystem:
        observedEngine.operatingSystem ??
        safeMetadataValue(profileEngine.operatingSystem)?.toLowerCase() ??
        null,
      architecture:
        observedEngine.architecture ?? normalizeDockerArchitecture(profileEngine.architecture)
    };
    return {
      contractVersion: profile.contractVersion,
      path: "host-environment.json",
      rootSetting: "PARKBENCH_HOST_DATA_ROOT",
      capturedAt: profile.capturedAt,
      host: {
        osId: safeMetadataValue(profile.host?.osId),
        osRelease: safeMetadataValue(profile.host?.osRelease),
        codename: safeMetadataValue(profile.host?.codename),
        kernel: safeMetadataValue(profile.host?.kernel),
        architecture: safeMetadataValue(profile.host?.architecture)
      },
      toolchain: {
        node: safeMetadataValue(profile.toolchain?.node),
        npm: safeMetadataValue(profile.toolchain?.npm),
        dockerClient: safeMetadataValue(profile.toolchain?.dockerClient),
        compose: safeMetadataValue(profile.toolchain?.compose),
        compilerAdapterVersion: safeMetadataValue(profile.toolchain?.compilerAdapterVersion)
      },
      engine
    };
  } catch {
    return undefined;
  }
}

function validUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function safeMetadataValue(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 128) return null;
  return /^[A-Za-z0-9._ +:/-]+$/.test(value) ? value : null;
}

function normalizeDockerArchitecture(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (["x86_64", "amd64", "x64"].includes(value.toLowerCase())) return "amd64";
  if (["aarch64", "arm64"].includes(value.toLowerCase())) return "arm64";
  return safeMetadataValue(value);
}

function parsePublishedPort(output: string): number | undefined {
  const match = output.trim().match(/:(\d+)\s*$/);
  return match ? Number(match[1]) : undefined;
}

export class FakeRunOrchestrator implements RunOrchestrator {
  readonly calls: string[] = [];
  readonly resources: RunResource[] = [];
  ready = true;
  stopFailure = false;
  cleanupFailure = false;
  /** When set, applyDatabaseLatency fails with this code. */
  latencyFailure?: string;
  constructor(
    private readonly metadataValue: Record<string, unknown> = { docker: "fake" },
    private readonly localImages: Array<Record<string, unknown>> = []
  ) {}
  async provision(bundle: ComposeBundle): Promise<RunResource[]> {
    this.calls.push("provision");
    const resources = bundle.resources.map((resource) => ({
      resourceType: resource.type as RunResource["resourceType"],
      resourceId: resource.name,
      labels: resource.labels,
      createdAt: new Date().toISOString()
    }));
    this.resources.push(...resources);
    return resources;
  }
  async waitForReady(
    _bundle?: ComposeBundle,
    _scenario?: Scenario,
    _timeoutMs?: number,
    isCancelled?: () => boolean
  ): Promise<void> {
    this.calls.push("ready");
    if (isCancelled?.()) throw new Error("run_cancelled");
    if (!this.ready) throw new Error("run_readiness_timeout");
    if (_bundle?.databaseRunControls) await this.checkDatabaseRunControls(_bundle);
  }
  async checkDatabaseRunControls(
    bundle: ComposeBundle,
    allowPending = false
  ): Promise<DatabaseRunControlsEvidence | undefined> {
    const c = bundle.databaseRunControls;
    if (!c) return undefined;
    const writers: NonNullable<DatabaseRunControlsEvidence["observed"]>["writers"] = [];
    for (let i = 0; i < c.apwCount; i++)
      writers.push({ type: "APW", pid: 100 + i, connectionId: 10 + i });
    if (c.biwEnabled) writers.push({ type: "BIW", pid: 200, connectionId: 20 });
    const now = new Date().toISOString();
    return (bundle.databaseRunControlEvidence = {
      contractVersion: "db-run-controls-evidence.v1",
      capturedAt: now,
      verification: "matched",
      writerHealth: "verified",
      reason: "",
      lastSuccessAt: now,
      observed: {
        contractVersion: "db-startup-state.v1",
        capturedAt: now,
        nativeClusterKiB: c.biCluster.mode === "override" ? c.biCluster.nativeKiB : 512,
        biBuffers: bundle.expectedBiBuffers ?? 64,
        connectionCapacity: 100,
        connectedCount: 4 + writers.length,
        apwCount: c.apwCount,
        biwCount: Number(c.biwEnabled),
        writers
      }
    });
  }
  async startWorkload(): Promise<void> {
    this.calls.push("start-workload");
  }
  async applyDatabaseLatency(
    _bundle: ComposeBundle,
    request: DatabaseLatencyRequest,
    isCancelled?: () => boolean
  ): Promise<DatabaseLatencyEvidence> {
    this.calls.push("applyDatabaseLatency");
    if (isCancelled?.()) throw new Error("run_cancelled");
    if (this.latencyFailure) throw new DatabaseLatencyError(this.latencyFailure, { targets: [] });
    return {
      contractVersion: DATABASE_LATENCY_CONTRACT_VERSION,
      requestedMs: request.delayMs,
      appliedMs: request.delayMs,
      mode: "simulated",
      status: "simulated",
      targets: [],
      applyDurationMs: 0,
      appliedAt: new Date().toISOString()
    };
  }
  async stopWorkload(): Promise<void> {
    this.calls.push("stop-workload");
    if (this.stopFailure) throw new Error("fake_stop_failed");
  }
  async waitForWorkload(): Promise<number> {
    this.calls.push("wait-workload");
    return 0;
  }
  async collectLogs(): Promise<string> {
    this.calls.push("collect-logs");
    return "fake logs\n";
  }
  async cleanup(_bundle: ComposeBundle, resources: RunResource[]): Promise<RunResource[]> {
    this.calls.push("cleanup");
    const cleaned = cleanupOwnedResources(
      resources,
      resources[0]?.labels["parkbench.run_id"] ?? ""
    );
    return this.cleanupFailure
      ? cleaned.map((resource) => ({ ...resource, cleanupResult: "fake_cleanup_failed" }))
      : cleaned;
  }
  async metadata(): Promise<Record<string, unknown>> {
    return this.metadataValue;
  }
  async health(): Promise<boolean> {
    return true;
  }
  async inspectImage(): Promise<boolean> {
    return true;
  }
  async inspectImageDetails(image: string): Promise<Record<string, unknown>> {
    return { reference: image, resolved: image };
  }
  async listLocalImages(): Promise<Array<Record<string, unknown>>> {
    return this.localImages.map((image) => ({ ...image }));
  }
}
