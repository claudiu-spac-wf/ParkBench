import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ReportMetadata } from "../../contracts/src/database-analysis-report";
import { buildReportCompose, ReportComposeOptions, reportContainerName } from "./report-compose";
export interface ReportResource {
  reportId: string;
  token: string;
  directory: string;
  composeFile: string;
  options: ReportComposeOptions;
  creationUncertain?: string;
  stages?: Record<
    string,
    { createdAt?: string; finishedAt?: string; exitCode?: number; cleanupConfirmedAt?: string }
  >;
}
export interface ReportCallbacks {
  cancelled(): boolean;
  closed(): boolean;
  update(version: string, mounts: any[]): void;
  resourceChanged?(resource: ReportResource): void;
}
export interface AnalysisRunner {
  execute(
    report: ReportMetadata,
    resource: ReportResource,
    callbacks: ReportCallbacks
  ): Promise<any>;
  cleanup(resource: ReportResource): Promise<void>;
}
/** Control calls are bounded; native lifetime and log streams are not. */
export function dockerControl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("report_docker_control_unavailable"));
    }, 30000);
    child.stdout.on("data", (c) => {
      if (out.length + c.length > 1048576) {
        child.kill();
        reject(new Error("report_docker_control_output_limit"));
      } else out += c;
    });
    child.stderr.on("data", (c) => {
      if (err.length < 8192) err += c;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("report_docker_control_failed:" + err.slice(0, 512)));
      else resolve(out);
    });
  });
}
export class DockerAnalysisRunner implements AnalysisRunner {
  constructor(
    private readonly control = dockerControl,
    private readonly pause: (ms: number) => Promise<any> = delay,
    private readonly captureLogs?: (resource: ReportResource, stage: string) => Promise<void>
  ) {}
  private async owned(resource: ReportResource, stage: string) {
    const name = reportContainerName(resource.reportId, resource.token, stage);
    const listed = await this.control([
      "ps",
      "-a",
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.ID}}"
    ]);
    if (!listed.trim()) return;
    const inspect = JSON.parse(await this.control(["inspect", listed.trim()]));
    const value = inspect[0];
    const labels = value.Config?.Labels ?? {};
    if (
      labels["parkbench.resource_kind"] !== "report" ||
      labels["parkbench.report_id"] !== resource.reportId ||
      labels["parkbench.owner_token"] !== resource.token
    )
      throw new Error("report_resource_ownership_invalid");
    return value;
  }
  private async logs(resource: ReportResource, stage: string) {
    if (this.captureLogs) return this.captureLogs(resource, stage);
    const name = reportContainerName(resource.reportId, resource.token, stage),
      target = fs.createWriteStream(path.join(resource.directory, "execution", stage + ".log"), {
        flags: "a"
      });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["logs", name], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.pipe(target, { end: false });
      child.stderr.pipe(target, { end: false });
      child.on("error", reject);
      target.on("error", (e) => {
        child.kill();
        reject(e);
      });
      child.on("close", (code) => {
        target.end(() =>
          code === 0 ? resolve() : reject(new Error("report_diagnostic_capture_failed"))
        );
      });
    });
  }
  private async stage(resource: ReportResource, stage: string, callbacks: ReportCallbacks) {
    if (callbacks.cancelled()) throw new Error("report_cancelled");
    resource.stages ??= {};
    resource.stages[stage] = { createdAt: new Date().toISOString() };
    callbacks.resourceChanged?.(resource);
    try {
      await this.control(["compose", "-f", resource.composeFile, "create", "--no-build", stage]);
    } catch (error) {
      if ((error as Error).message === "report_docker_control_unavailable") {
        resource.creationUncertain = stage;
        callbacks.resourceChanged?.(resource);
      }
      throw error;
    }
    if (callbacks.cancelled()) throw new Error("report_cancelled");
    await this.control(["start", reportContainerName(resource.reportId, resource.token, stage)]);
    for (;;) {
      if (callbacks.closed()) throw new Error("report_controller_closed");
      if (callbacks.cancelled()) throw new Error("report_cancelled");
      let inspect: any;
      try {
        inspect = await this.owned(resource, stage);
      } catch {
        await this.pause(1000);
        continue;
      }
      if (!inspect) throw new Error("report_execution_failed");
      if (["exited", "dead"].includes(inspect.State.Status)) {
        await this.logs(resource, stage);
        resource.stages[stage] = {
          ...resource.stages[stage],
          finishedAt: new Date().toISOString(),
          exitCode: inspect.State.ExitCode
        };
        callbacks.resourceChanged?.(resource);
        return inspect.State.ExitCode as number;
      }
      await this.pause(1000);
    }
  }
  async execute(report: ReportMetadata, resource: ReportResource, callbacks: ReportCallbacks) {
    fs.writeFileSync(
      resource.composeFile,
      JSON.stringify(buildReportCompose(resource.options), null, 2)
    );
    await this.stage(resource, "version", callbacks);
    const fd = fs.openSync(path.join(resource.directory, "execution", "version.log"), "r"),
      buffer = Buffer.alloc(65536);
    let versionText: string;
    try {
      const n = fs.readSync(fd, buffer);
      versionText = buffer.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const version = /(?:OpenEdge[^\n]*?(?:Release|Version)\s+|Release\s+)(12\.8(?:\.\d+)?)/i.exec(
      versionText
    )?.[1];
    if (!version) throw new Error("report_tool_version_unsupported");
    callbacks.update(
      version,
      buildReportCompose(resource.options).services.analysis.volumes.map((v: any) => ({
        source: v.source,
        target: v.target,
        readOnly: !!v.read_only
      }))
    );
    const exitCode = await this.stage(resource, "analysis", callbacks);
    let warning = false,
      startupFailed = false,
      previous = "";
    for await (const chunk of fs.createReadStream(
      path.join(resource.directory, "execution", "analysis.log")
    )) {
      const text = previous + chunk.toString("utf8");
      if (/\bwarning\b/i.test(text)) warning = true;
      if (text.includes("report_database_start_failed")) startupFailed = true;
      previous = text.slice(-64);
    }
    if (exitCode !== 0)
      throw new Error(startupFailed ? "report_database_start_failed" : "report_execution_failed");
    return { version, warnings: warning ? ["report_execution_warning"] : [] };
  }
  async cleanup(resource: ReportResource) {
    if (resource.creationUncertain && !(await this.owned(resource, resource.creationUncertain)))
      throw new Error("report_cleanup_failed");
    for (const stage of ["analysis", "structure", "busy", "version"]) {
      const owned = await this.owned(resource, stage);
      if (!owned) continue;
      if (owned.State.Running) {
        await this.control(["stop", "--time", "10", owned.Id]);
      }
      const current = await this.owned(resource, stage);
      if (current?.State.Running) throw new Error("report_cleanup_failed");
      if (current) {
        if (!resource.stages?.[stage]?.finishedAt) await this.logs(resource, stage);
        await this.control(["rm", current.Id]);
      }
      if (await this.owned(resource, stage)) throw new Error("report_cleanup_failed");
      if (resource.creationUncertain === stage) delete resource.creationUncertain;
      resource.stages ??= {};
      resource.stages[stage] = {
        ...resource.stages[stage],
        cleanupConfirmedAt: new Date().toISOString()
      };
    }
    const scratch = path.join(resource.directory, "scratch");
    if (fs.existsSync(scratch)) {
      if (fs.lstatSync(scratch).isSymbolicLink()) throw new Error("report_cleanup_failed");
      await fs.promises.rm(scratch, { recursive: true, force: true });
    }
  }
}
