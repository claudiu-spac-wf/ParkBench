import { COVERAGE } from "../../../../packages/contracts/src/database-analysis-definitions";
import { rebuildRetainedProjection } from "./rebuild";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  REPORT_VERSION,
  REPORT_VERSIONS,
  DATASET_KINDS,
  ReportMetadata,
  ReportRequest,
  ReportFailure,
  validateReportRequest,
  terminalReport
} from "../../../../packages/contracts/src/database-analysis-report";
import {
  AnalysisRunner,
  ReportResource
} from "../../../../packages/compose-runner/src/report-runner";
import { ReportRepository, canonicalRequest } from "./repository";
import { ReportArtifacts } from "./artifacts";
import { validateReportSeed } from "./preflight";
import { finalizeOutput } from "./finalization";
import { HostDispatcher } from "../execution/host-dispatcher";
export function reportFailure(code: string): ReportFailure {
  const safe = /^(?:ENOSPC|EDQUOT|EACCES|EROFS|EMFILE)/.test(code)
    ? "report_storage_failed"
    : /^report_[a-z_]+$/.test(code)
      ? code
      : "report_execution_failed";
  const actions: Record<string, string> = {
    report_seed_not_offline: "Keep the seed database broker stopped and submit a new report.",
    report_seed_invalid: "Select a valid ready seed from Catalog.",
    report_seed_extent_paths_unavailable:
      "Review retained diagnostics from the temporary database copy and its extent preparation.",
    report_database_start_failed:
      "Check the licensed DB image, seed copy and broker startup diagnostics.",
    report_tool_version_unsupported:
      "Configure a licensed OpenEdge 12.8 image supported by this adapter.",
    report_interrupted:
      "The controller restarted. Retained evidence remains available; submit a new report if needed.",
    report_cleanup_failed:
      "Capacity remains reserved. Cleanup retries five seconds after each failed attempt finishes; restore Docker connectivity.",
    report_dataset_missing: "Review native diagnostics: a required output file is missing.",
    report_output_invalid:
      "Review retained native evidence; conversion could not establish complete output."
  };
  return {
    code: safe,
    message: safe.replace(/^report_/, "").replace(/_/g, " "),
    correctiveAction:
      actions[safe] ??
      "Review retained diagnostics and correct the reported environment before submitting a new report."
  };
}
export interface ReportClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface ReportServiceOptions {
  clock?: ReportClock;
  image: string;
  licensePath?: string;
  version?: string;
  resolveSeed(id: string): ReportMetadata["seedSnapshot"];
  cleanupRetryMs?: number;
}
export class ReportService {
  private closed = false;
  private starting = false;
  private workers = new Set<string>();
  private activeExecutions = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: () => void;
  constructor(
    readonly repository: ReportRepository,
    readonly artifacts: ReportArtifacts,
    readonly runner: AnalysisRunner,
    readonly gate: HostDispatcher,
    readonly options: ReportServiceOptions
  ) {
    this.unsubscribe = gate.onAvailable(() => void this.dispatch());
  }
  private now() {
    return this.options.clock?.now() ?? Date.now();
  }
  private timestamp() {
    return new Date(this.now()).toISOString();
  }
  private clearTimer(timer: ReturnType<typeof setTimeout>) {
    if (this.options.clock) this.options.clock.clearTimeout(timer);
    else clearTimeout(timer);
  }
  create(input: unknown, key: string) {
    if (!validateReportRequest(input)) throw new Error("report_request_invalid");
    if (!key || key.length > 512) throw new Error("report_idempotency_key_invalid");
    const text = canonicalRequest(input),
      replay = this.repository.replay(key, text);
    if (replay) return replay;
    const seedSnapshot = this.options.resolveSeed(input.seedAssetId);
    const report: ReportMetadata = {
      id: randomUUID(),
      queueSequence: 0,
      contractVersion: REPORT_VERSION,
      family: "database-analysis",
      type: input.type,
      state: "QUEUED",
      createdAt: this.timestamp(),
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      seedSnapshot,
      executionSnapshot: {
        image: this.options.image,
        observedVersion: null,
        sourceEncoding: "UTF-8",
        options: ["-csoutput", "-fieldsep", ",", "-verbose", "-csfilePrefix", "report"],
        mounts: [],
        platformVersion: "0.1.0"
      },
      ...REPORT_VERSIONS,
      failure: null,
      warnings: [],
      projectionState: "PENDING",
      projectionRevision: null,
      cleanupState: "PENDING",
      pendingTerminalState: null,
      pendingFailure: null,
      cleanupRetryAt: null,
      datasets: DATASET_KINDS.map((kind) => ({
        kind,
        availability: COVERAGE[input.type].includes(kind) ? "MISSING" : "NOT_COLLECTED",
        reason: COVERAGE[input.type].includes(kind)
          ? "Awaiting native collection"
          : "Not collected by this report type",
        rowCount: "0",
        complete: !COVERAGE[input.type].includes(kind),
        columns: []
      })),
      artifacts: []
    };
    const saved = this.repository.create(report, key, text);
    this.gate.wake();
    return saved;
  }
  cancel(id: string) {
    const report = this.repository.get(id);
    if (!report) throw new Error("report_not_found");
    if (terminalReport(report.state)) return report;
    report.cancelRequestedAt ??= this.timestamp();
    if (report.state === "QUEUED") {
      report.state = "CANCELLED";
      report.finishedAt = this.timestamp();
      report.cleanupState = "CONFIRMED";
      this.repository.save(report);
      this.gate.wake();
    } else {
      if (report.pendingFailure?.code !== "report_interrupted") {
        report.pendingTerminalState = "CANCELLED";
        report.pendingFailure = null;
      }
      this.repository.save(report);
      if (!this.activeExecutions.has(id))
        this.scheduleCleanup(
          report,
          report.cleanupRetryAt ? Math.max(0, Date.parse(report.cleanupRetryAt) - this.now()) : 0
        );
    }
    return this.repository.get(id)!;
  }
  async dispatch() {
    if (
      this.closed ||
      !this.gate.canDispatchReports() ||
      this.starting ||
      this.repository.currentClaim() ||
      (this.gate.busy() && !this.repository.oldest())
    )
      return;
    const report = this.repository.oldest();
    if (!report) return;
    this.starting = true;
    let token: string | undefined;
    try {
      token = this.repository.claim("REPORT", report.id);
      if (!token) return;
      report.state = "RUNNING";
      report.startedAt = this.timestamp();
      this.repository.save(report);
      const directory = this.artifacts.execution(report.id);
      const resource: ReportResource = {
        reportId: report.id,
        token,
        directory,
        composeFile: path.join(directory, "execution", "compose.json"),
        options: {
          reportId: report.id,
          token,
          directory,
          seedPath: report.seedSnapshot.path,
          databaseName: report.seedSnapshot.databaseName,
          image: report.executionSnapshot.image,
          type: report.type,
          aliases: [],
          licensePath: this.options.licensePath
        }
      };
      this.repository.resource(report.id, token, resource);
      void this.execute(report, resource);
    } catch (error) {
      if (token) {
        const current = this.repository.get(report.id)!;
        current.pendingTerminalState = "FAILED";
        current.pendingFailure = reportFailure((error as Error).message);
        this.repository.save(current);
        this.scheduleCleanup(current, 0);
      }
    } finally {
      this.starting = false;
    }
  }
  private async execute(report: ReportMetadata, resource: ReportResource) {
    this.activeExecutions.add(report.id);
    let error: Error | undefined;
    let executionResult: any;
    try {
      validateReportSeed(report);
      executionResult = await this.runner.execute(report, resource, {
        cancelled: () => this.closed || !!this.repository.get(report.id)?.cancelRequestedAt,
        closed: () => this.closed,
        resourceChanged: (updated) => {
          if (!this.closed) this.repository.resource(report.id, resource.token, updated);
        },
        update: (version, mounts) => {
          if (this.closed) return;
          const current = this.repository.get(report.id)!;
          current.executionSnapshot.observedVersion = version;
          current.executionSnapshot.mounts = mounts;
          this.repository.save(current);
          this.repository.resource(report.id, resource.token, resource);
        }
      });
    } catch (e) {
      error = e as Error;
    }
    this.activeExecutions.delete(report.id);
    if (this.closed) return;
    const current = this.repository.get(report.id)!;
    if (executionResult?.warnings?.includes("report_execution_warning"))
      current.warnings.push(reportFailure("report_execution_warning"));
    current.pendingTerminalState = current.cancelRequestedAt
      ? "CANCELLED"
      : error
        ? "FAILED"
        : "COMPLETED";
    current.pendingFailure =
      current.pendingTerminalState === "FAILED" ? reportFailure(error!.message) : null;
    this.repository.save(current);
    this.scheduleCleanup(current, 0);
  }
  private scheduleCleanup(report: ReportMetadata, ms: number) {
    if (this.closed || this.workers.has(report.id)) return;
    const existing = this.timers.get(report.id);
    if (existing) {
      if (ms !== 0) return;
      this.clearTimer(existing);
    }
    const timer = (this.options.clock?.setTimeout.bind(this.options.clock) ?? setTimeout)(() => {
      this.timers.delete(report.id);
      void this.cleanup(report.id);
    }, ms);
    timer.unref?.();
    this.timers.set(report.id, timer);
  }
  private cleanupDiagnostic(id: string, message: string) {
    try {
      const dir = path.join(this.artifacts.directory(id), "execution");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "cleanup.log"), this.timestamp() + " " + message + "\n");
    } catch {
      /* Storage failure is reflected by finalization/cleanup status. */
    }
  }
  private async cleanup(id: string) {
    if (this.closed || this.workers.has(id)) return;
    this.workers.add(id);
    let retry = false;
    try {
      let report = this.repository.get(id)!;
      if (!report.pendingTerminalState) return;
      this.cleanupDiagnostic(id, "Cleanup attempt started; pending " + report.pendingTerminalState);
      const resources = this.repository.resources(id);
      for (const resource of resources) {
        await this.runner.cleanup(resource);
        if (this.closed) return;
        this.repository.resource(id, resource.token, resource);
      }
      report = this.repository.get(id)!;
      // Cancellation before publication wins ordinary completion; interrupted failures are retained.
      if (report.cancelRequestedAt && report.pendingFailure?.code !== "report_interrupted") {
        report.pendingTerminalState = "CANCELLED";
        report.pendingFailure = null;
      }
      if (!report.projectionRevision) {
        try {
          await finalizeOutput(
            this.repository,
            this.artifacts,
            report,
            report.pendingTerminalState === "COMPLETED"
          );
        } catch (e) {
          if (this.closed) return;
          const current = this.repository.get(id)!;
          if (
            current.pendingTerminalState !== "CANCELLED" &&
            current.pendingFailure?.code !== "report_interrupted"
          ) {
            current.pendingTerminalState = "FAILED";
            current.pendingFailure = reportFailure((e as Error).message);
          }
          this.repository.save(current);
        }
      }
      if (this.closed) return;
      report = this.repository.get(id)!;
      if (report.cancelRequestedAt && report.pendingFailure?.code !== "report_interrupted") {
        report.pendingTerminalState = "CANCELLED";
        report.pendingFailure = null;
      }
      this.cleanupDiagnostic(id, "Owned termination/removal confirmed; publishing outcome");
      // Capture bounded-control diagnostic files as independent retained evidence.
      const execution = path.join(this.artifacts.directory(id), "execution");
      if (fs.existsSync(execution))
        for (const filename of fs.readdirSync(execution)) {
          if (!filename.endsWith(".log")) continue;
          const file = path.join(execution, filename);
          if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) continue;
          if (report.artifacts.some((a) => a.filename === filename)) continue;
          const staging = path.join(this.artifacts.directory(id), randomUUID() + ".tmp");
          await fs.promises.copyFile(file, staging);
          this.artifacts.publishStaged(id, staging, filename, "DIAGNOSTIC", true);
        }
      report = this.repository.get(id)!;
      report.state = report.pendingTerminalState!;
      report.failure = report.pendingFailure;
      report.pendingTerminalState = null;
      report.pendingFailure = null;
      report.finishedAt = this.timestamp();
      report.cleanupState = "CONFIRMED";
      report.cleanupRetryAt = null;
      report.warnings = report.warnings.filter((w) => w.code !== "report_cleanup_failed");
      this.repository.transaction(() => {
        this.repository.save(report);
        for (const resource of resources) this.repository.release(resource.token);
        const claim = this.repository.currentClaim();
        if (claim?.kind === "REPORT" && claim.owner_id === id) this.repository.release(claim.token);
      });
      this.gate.wake();
    } catch {
      if (!this.closed) {
        this.cleanupDiagnostic(
          id,
          "Cleanup unconfirmed; scheduling the same worker in five seconds"
        );
        const report = this.repository.get(id)!;
        report.cleanupState = "FAILED";
        report.cleanupRetryAt = new Date(
          this.now() + (this.options.cleanupRetryMs ?? 5000)
        ).toISOString();
        report.warnings = [
          ...report.warnings.filter((w) => w.code !== "report_cleanup_failed"),
          reportFailure("report_cleanup_failed")
        ];
        this.repository.save(report);
        retry = true;
      }
    } finally {
      this.workers.delete(id);
      if (retry && !this.closed)
        this.scheduleCleanup(this.repository.get(id)!, this.options.cleanupRetryMs ?? 5000);
    }
  }
  async recover() {
    for (const report of this.repository
      .list()
      .filter((r) => terminalReport(r.state) && r.projectionRevision)) {
      if (
        !this.repository.db
          .prepare("SELECT 1 FROM report_summaries WHERE report_id=? AND revision=?")
          .get(report.id, report.projectionRevision)
      ) {
        try {
          await rebuildRetainedProjection(this.repository, this.artifacts, report.id);
        } catch {
          const current = this.repository.get(report.id)!;
          current.projectionState = "UNAVAILABLE";
          this.repository.save(current);
        }
      }
    }
    for (const report of this.repository.list("RUNNING")) {
      report.pendingTerminalState = "FAILED";
      report.pendingFailure = reportFailure("report_interrupted");
      this.repository.save(report);
      const resources = this.repository.resources(report.id);
      if (!this.repository.currentClaim())
        this.repository.claim("REPORT", report.id, resources[0]?.token);
      const at = report.cleanupRetryAt ? Date.parse(report.cleanupRetryAt) : Date.now();
      this.scheduleCleanup(report, Math.max(0, at - this.now()));
    }
  }
  close() {
    this.closed = true;
    this.unsubscribe();
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
  }
}
