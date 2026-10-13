import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CatalogAction,
  CatalogActionKind,
  CatalogActionResult,
  CATALOG_WORKFLOW_CONTRACT_VERSION
} from "../../../../packages/contracts/src/catalog";
import { ControlUiRepository } from "../storage/control-ui-repository";
import { ScenarioFileSource } from "./scenario-source";
import { ManagedRootFileDiscovery } from "./file-discovery";
import {
  validateRequiredMeasurements,
  validateScenarioDatabaseParameterDefinitions
} from "./scenario-validation";

const exec = promisify(execFile);
const checkedAt = () => new Date().toISOString();
const diagnostic = (error: unknown) =>
  String(error instanceof Error ? error.message : error).slice(0, 1500);
export const safeArchiveName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);

export class CatalogBulkActions {
  constructor(
    private readonly repository: ControlUiRepository,
    private readonly roots: {
      scenarios?: string;
      workloads?: string;
      observers?: string;
      archives?: string;
    },
    private readonly pasImage?: string,
    private readonly dbImage?: string,
    private readonly dbCapabilities?: { version?: string; features?: string[] }
  ) {
    for (const action of repository
      .listCatalogActions()
      .filter((item) => item.state === "PENDING" || item.state === "RUNNING")) {
      action.state = "FAILED";
      action.finishedAt = checkedAt();
      action.error = {
        code: "catalog_action_interrupted",
        message: "The process stopped before this action finished."
      };
      repository.saveCatalogAction(action);
    }
  }

  start(kind: CatalogActionKind, archiveName?: string): CatalogAction {
    if (!["VERIFY_SCENARIOS", "COMPILE_WORKLOADS", "REBUILD_ARCHIVE"].includes(kind))
      throw new Error("catalog_action_invalid");
    if (kind === "REBUILD_ARCHIVE" && !safeArchiveName(archiveName))
      throw new Error("archive_name_invalid");
    if (kind !== "REBUILD_ARCHIVE" && archiveName !== undefined)
      throw new Error("archive_name_not_allowed");
    const action: CatalogAction = {
      contractVersion: CATALOG_WORKFLOW_CONTRACT_VERSION,
      id: `catalog-${crypto.randomUUID()}`,
      kind,
      archiveName,
      state: "PENDING",
      createdAt: checkedAt(),
      results: []
    };
    this.repository.saveCatalogAction(action);
    setImmediate(
      () =>
        void this.execute(action).catch((error) => {
          action.state = "FAILED";
          action.finishedAt = checkedAt();
          action.error = { code: "catalog_action_failed", message: diagnostic(error) };
          this.repository.saveCatalogAction(action);
        })
    );
    return action;
  }

  get(id: string): CatalogAction | undefined {
    return this.repository.getCatalogAction(id);
  }

  private async execute(action: CatalogAction): Promise<void> {
    action.state = "RUNNING";
    action.startedAt = checkedAt();
    this.repository.saveCatalogAction(action);
    if (action.kind === "VERIFY_SCENARIOS") await this.verifyScenarios(action);
    else await this.compileWorkloads(action, action.kind === "REBUILD_ARCHIVE");
    if (action.state === "RUNNING") {
      const passed = action.results.filter((item) => item.state === "PASSED").length;
      const failed = action.results.length - passed;
      action.state =
        failed === 0 && passed > 0 ? "SUCCEEDED" : passed > 0 && failed > 0 ? "PARTIAL" : "FAILED";
      action.finishedAt = checkedAt();
      this.repository.saveCatalogAction(action);
    }
  }

  private async verifyScenarios(action: CatalogAction): Promise<void> {
    const sources = new ScenarioFileSource(this.roots.scenarios);
    for (const entry of sources.list()) {
      const result: CatalogActionResult = {
        path: entry.relativePath,
        state: "PASSED",
        checkedAt: checkedAt()
      };
      try {
        const { scenario } = sources.get(entry.id);
        validateRequiredMeasurements(scenario);
        const definitions = (scenario as any).parameterDefinitions;
        if (Array.isArray(definitions))
          validateScenarioDatabaseParameterDefinitions(definitions, this.dbCapabilities ?? {});
        const workloads = new Set<string>();
        if (scenario.assetRefs?.workload) workloads.add(scenario.assetRefs.workload);
        for (const operation of scenario.workload.operations) {
          const procName = (operation.bodyTemplate as any)?.procName;
          if (typeof procName === "string") workloads.add(procName.replace(/^Workloads\//, ""));
        }
        for (const ref of workloads) {
          const relative = ref.replace(/^input:workloads\//, "").replace(/^Workloads\//, "");
          if (!this.safeFile(this.roots.workloads, relative))
            throw new Error(`workload_missing:${ref}`);
        }
        for (const ref of scenario.assetRefs?.observers ?? []) {
          const relative = ref.replace(/^input:observers\//, "");
          if (!this.safeFile(this.roots.observers, relative))
            throw new Error(`observer_missing:${ref}`);
        }
      } catch (error) {
        result.state = "FAILED";
        result.reasonCode = diagnostic(error).split(":")[0];
        result.message = diagnostic(error);
      }
      action.results.push(result);
      this.repository.saveCatalogAction(action);
    }
  }

  private safeFile(root: string | undefined, relative: string): boolean {
    if (!root || !relative || path.isAbsolute(relative)) return false;
    try {
      const realRoot = fs.realpathSync(root);
      const full = fs.realpathSync(path.resolve(realRoot, relative));
      return full.startsWith(`${realRoot}${path.sep}`) && fs.statSync(full).isFile();
    } catch {
      return false;
    }
  }

  private async compileWorkloads(action: CatalogAction, publish: boolean): Promise<void> {
    const sources = new ManagedRootFileDiscovery(this.roots).discoverRoot("workloads").items;
    const stageBase = this.roots.archives
      ? path.dirname(this.roots.archives)
      : (process.env.PARKBENCH_CONTAINER_PATH_ROOT ?? os.tmpdir());
    fs.mkdirSync(stageBase, { recursive: true });
    const stage = fs.mkdtempSync(path.join(stageBase, "parkbench-catalog-"));
    const stageWorkloads = path.join(stage, "workloads");
    fs.mkdirSync(stageWorkloads);
    try {
      const compiler = process.env.PARKBENCH_OPENEDGE_COMPILER;
      for (const source of sources) {
        const relative = String(source.provenance.relativePath);
        const result: CatalogActionResult = {
          path: relative,
          state: "PASSED",
          checkedAt: checkedAt()
        };
        try {
          if (!compiler) throw new Error("compiler_not_configured");
          const original = path.join(this.roots.workloads!, relative);
          const isolated = path.join(stage, "isolated", crypto.randomUUID());
          fs.mkdirSync(isolated, { recursive: true });
          const staged = path.join(isolated, path.basename(relative));
          fs.copyFileSync(original, staged);
          const command =
            compiler.endsWith(".mjs") || compiler.endsWith(".js") ? process.execPath : compiler;
          const args = command === process.execPath ? [compiler, staged] : [staged];
          await exec(command, args, {
            timeout: 180000,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE:
                this.dbImage ?? process.env.PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE
            }
          });
          const compiled = staged.slice(0, -2) + ".r";
          if (!fs.existsSync(compiled)) throw new Error("compiler_output_missing");
          if (publish) {
            const outputSource = path.join(stageWorkloads, relative);
            fs.mkdirSync(path.dirname(outputSource), { recursive: true });
            fs.copyFileSync(staged, outputSource);
            fs.copyFileSync(compiled, outputSource.slice(0, -2) + ".r");
          }
        } catch (error) {
          result.state = "FAILED";
          result.reasonCode = diagnostic(error).split(":")[0];
          result.message = diagnostic(error);
        }
        action.results.push(result);
        this.repository.saveCatalogAction(action);
      }
      if (!publish) return;
      const included = action.results
        .filter((item) => item.state === "PASSED")
        .map((item) => `Workloads/${item.path.slice(0, -2)}.r`);
      const excluded = action.results
        .filter((item) => item.state === "FAILED")
        .map((item) => ({
          procedure: `Workloads/${item.path.slice(0, -2)}.r`,
          reasonCode: item.reasonCode
        }));
      if (!included.length) return;
      const manifest = {
        contractVersion: "archive-contents.v1",
        state: excluded.length ? "PARTIAL" : "COMPLETE",
        included,
        excluded
      };
      const manifestPath = path.join(stage, "archive-contents.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const handler = path.join(stage, "ParkBenchWorkHandler.cls");
      fs.copyFileSync(path.resolve("openedge/runner/ParkBenchWorkHandler.cls"), handler);
      const handlerCompiler = process.env.PARKBENCH_OPENEDGE_COMPILER!;
      const handlerCommand =
        handlerCompiler.endsWith(".mjs") || handlerCompiler.endsWith(".js")
          ? process.execPath
          : handlerCompiler;
      await exec(
        handlerCommand,
        handlerCommand === process.execPath ? [handlerCompiler, handler] : [handler],
        {
          timeout: 180000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE:
              this.dbImage ?? process.env.PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE
          }
        }
      );
      if (!fs.existsSync(handler.slice(0, -4) + ".r"))
        throw new Error("handler_compilation_missing");
      const script = path.resolve("scripts/openedge/create-runner-archive.mjs");
      await exec(
        process.execPath,
        [
          script,
          "--output-root",
          path.join(stage, "build"),
          "--workload-root",
          stageWorkloads,
          "--skip-compilation",
          "--manifest",
          manifestPath,
          "--handler-path",
          handler,
          ...(this.pasImage ? ["--pasoe-image", this.pasImage] : [])
        ],
        { timeout: 300000, maxBuffer: 1024 * 1024 }
      );
      const sourceArchive = path.join(stage, "build", "archives", "oepas1.zip");
      if (!this.roots.archives) throw new Error("archives_root_not_configured");
      fs.mkdirSync(this.roots.archives, { recursive: true });
      const target = path.join(this.roots.archives, `${action.archiveName}.zip`);
      const temporary = path.join(
        this.roots.archives,
        `.${action.archiveName}-${crypto.randomUUID()}.tmp`
      );
      try {
        fs.copyFileSync(sourceArchive, temporary, fs.constants.COPYFILE_EXCL);
        fs.linkSync(temporary, target);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      action.outputArchive = target;
      this.repository.saveCatalogAction(action);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
}
