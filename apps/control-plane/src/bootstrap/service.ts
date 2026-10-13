import { randomUUID } from "node:crypto";
import { BootstrapRepository, BootstrapRecord } from "./repository";
import { Repositories } from "../db/repositories";
import { ArtifactService } from "../artifacts/service";
import { Scenario } from "../../../../packages/contracts/src/scenario";
import { ExperimentRequest } from "../../../../packages/contracts/src/experiment";
import {
  checkCredentialReference,
  checkInputReference
} from "../../../../packages/compose-runner/src/input-checks";
import {
  generateRunCompose,
  ComposeBundle,
  RunOrchestrator
} from "../../../../packages/compose-runner/src";
import { composeProjectName } from "../../../../packages/compose-runner/src/project-name";
import { saveDiagnostics } from "../artifacts/diagnostics";
import { hostCapacity } from "../preflight/capacity";
import type { RunResource } from "../../../../packages/compose-runner/src/resources";
import type { SupportImages } from "../platform";
import type { ParkBenchConfig } from "../../../../packages/contracts/src/config";
import { privateInputValues } from "../../../../packages/contracts/src/redaction";
import { imageIdentitySnapshot } from "../../../../packages/contracts/src/image-reference";

export class BootstrapService {
  private readonly closeOperations = new Map<string, Promise<BootstrapRecord>>();
  constructor(
    private readonly repository = new BootstrapRepository(),
    private readonly repositories?: Repositories,
    private readonly orchestrator?: RunOrchestrator,
    private readonly artifacts?: ArtifactService,
    private readonly supportImages?: SupportImages,
    private readonly openedge?: ParkBenchConfig["openedge"]
  ) {}

  async create(request: ExperimentRequest, scenario: Scenario): Promise<BootstrapRecord> {
    checkCredentialReference(request.inputs.credentialRef);
    const inputProvenance = [
      checkInputReference(request.inputs.seed, "seed"),
      checkInputReference(request.inputs.applicationArchive, "application_archive")
    ];
    const environmentId = `env_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const record: BootstrapRecord = {
      environmentId,
      runId,
      state: "PROVISIONING",
      phase: "PROVISIONING",
      createdAt,
      scenario: JSON.parse(JSON.stringify(scenario)),
      inputs: {
        databaseImage: request.inputs.databaseImage,
        pasImage: request.inputs.pasImage,
        seed: request.inputs.seed,
        applicationArchive: request.inputs.applicationArchive
      },
      credentialReference: request.inputs.credentialRef,
      inputProvenance,
      composeProject: composeProjectName(runId),
      resolvedImages: {
        database: { reference: request.inputs.databaseImage },
        pas: { reference: request.inputs.pasImage },
        loadgen: { reference: this.supportImages?.loadgen },
        observer: { reference: this.supportImages?.observer }
      },
      hostCapacity: hostCapacity(),
      topology: {
        databaseService: scenario.target.databaseService,
        pasService: scenario.target.pasService,
        pasReplicas: scenario.target.pasReplicas
      },
      readiness: {
        state: "PROVISIONING",
        services: {
          database: { state: "PENDING" },
          pas: { state: "PENDING", replicas: scenario.target.pasReplicas }
        },
        transitions: [{ state: "PROVISIONING", at: createdAt }]
      },
      resources: [],
      diagnostics: [],
      cleanupStatus: "PENDING"
    };
    this.save(record);
    if (!this.orchestrator) return record;
    const bundle = this.bundleFor(record);
    void this.provision(record, bundle, scenario);
    return record;
  }

  get(id: string): BootstrapRecord | undefined {
    const stored = this.repositories?.getEnvironment(id);
    return (stored as unknown as BootstrapRecord | undefined) ?? this.repository.get(id);
  }

  async close(environmentId: string): Promise<BootstrapRecord> {
    const existing = this.closeOperations.get(environmentId);
    if (existing) return existing;
    const record = this.get(environmentId);
    if (!record) throw new Error("environment_not_found");
    if (!this.orchestrator || record.cleanupStatus === "COMPLETE") return record;
    if (record.state !== "READY" && record.state !== "FAILED")
      throw new Error("bootstrap_not_ready_for_close");
    if (record.state === "FAILED" && record.cleanupStatus === "IN_PROGRESS")
      throw new Error("bootstrap_cleanup_in_progress");
    if (!record.scenario || !record.runId) throw new Error("bootstrap_cleanup_context_missing");
    const operation = this.closeReady(record);
    this.closeOperations.set(environmentId, operation);
    try {
      return await operation;
    } finally {
      this.closeOperations.delete(environmentId);
    }
  }

  private async closeReady(record: BootstrapRecord): Promise<BootstrapRecord> {
    const bundle = this.bundleFor(record);
    const resources = this.repositories
      ? (this.repositories.listResources(record.runId) as unknown as RunResource[])
      : ((record.resources ?? []) as RunResource[]);
    record.resources = resources;
    record.cleanupStatus = "IN_PROGRESS";
    this.setReadiness(record, "CLEANUP", "bootstrap environment close requested");
    this.save(record);
    try {
      await this.cleanupRecord(record, bundle, resources, "bootstrap_close");
    } catch (error) {
      record.cleanupStatus = "FAILED";
      this.addDiagnostic(record, {
        code: "bootstrap_cleanup_failed",
        operation: "bootstrap_close",
        error: String(error)
      });
      this.save(record);
      throw error;
    }
    record.closedAt = new Date().toISOString();
    this.save(record);
    return record;
  }

  async retryPendingCleanup(): Promise<number> {
    if (!this.repositories || !this.orchestrator) return 0;
    let attempted = 0;
    for (const raw of this.repositories.findEnvironmentsNeedingCleanup()) {
      const record = raw as unknown as BootstrapRecord;
      if (!record.environmentId || !record.runId || !record.scenario) continue;
      attempted++;
      const bundle = this.bundleFor(record);
      const resources = this.repositories.listResources(record.runId) as unknown as RunResource[];
      record.state = record.state === "PROVISIONING" ? "FAILED" : record.state;
      this.setReadiness(record, "CLEANUP", "cleanup retry started");
      record.cleanupStatus = "IN_PROGRESS";
      record.resources = resources;
      this.save(record);
      try {
        await this.cleanupRecord(record, bundle, resources, "bootstrap_cleanup_retry");
      } catch (error) {
        record.cleanupStatus = "FAILED";
        this.addDiagnostic(record, {
          code: "bootstrap_cleanup_retry_failed",
          error: String(error)
        });
      }
      this.save(record);
    }
    return attempted;
  }

  private async provision(
    record: BootstrapRecord,
    bundle: ComposeBundle,
    scenario: Scenario
  ): Promise<void> {
    let resources: RunResource[] = [];
    try {
      resources = await this.orchestrator!.provision(bundle);
      resources.forEach((resource) => this.repositories?.saveResource(record.runId, resource));
      record.resources = resources;
      this.setReadiness(record, "PROVISIONING", "resources created");
      this.save(record);

      const [metadata, databaseImage, pasImage, loadgenImage, observerImage] = await Promise.all([
        this.orchestrator!.metadata(),
        this.orchestrator!.inspectImageDetails?.(this.imageReference(record, "database")),
        this.orchestrator!.inspectImageDetails?.(this.imageReference(record, "pas")),
        this.orchestrator!.inspectImageDetails?.(this.imageReference(record, "loadgen")),
        this.orchestrator!.inspectImageDetails?.(this.imageReference(record, "observer"))
      ]);
      record.hostDocker = metadata;
      record.resolvedImages = {
        database: imageIdentitySnapshot(this.imageReference(record, "database"), databaseImage),
        pas: imageIdentitySnapshot(this.imageReference(record, "pas"), pasImage),
        loadgen: imageIdentitySnapshot(this.imageReference(record, "loadgen"), loadgenImage),
        observer: imageIdentitySnapshot(this.imageReference(record, "observer"), observerImage)
      };
      this.setReadiness(record, "READINESS", "readiness probes started");
      this.save(record);
      await this.orchestrator!.waitForReady(bundle, scenario, 60000);
      record.state = "READY";
      record.phase = "READY";
      record.cleanupStatus = "PENDING";
      this.setReadiness(record, "READY", "database and PAS readiness probes passed");
      this.save(record);
    } catch (error) {
      record.state = "FAILED";
      record.phase = "FAILED";
      record.cleanupStatus = "IN_PROGRESS";
      this.setReadiness(record, "FAILED", "bootstrap readiness or provisioning failed");
      this.addDiagnostic(record, {
        code: "bootstrap_failed",
        error: String(error),
        affectedService: readinessServiceFromError(error)
      });
      record.resources = resources;
      this.save(record);
      try {
        await this.cleanupRecord(record, bundle, resources, "bootstrap_cleanup");
      } catch (cleanupError) {
        record.cleanupStatus = "FAILED";
        this.addDiagnostic(record, {
          code: "bootstrap_cleanup_failed",
          error: String(cleanupError)
        });
      }
      if (this.artifacts && this.repositories)
        saveDiagnostics(
          this.artifacts.storage,
          this.repositories,
          record.runId,
          record.diagnostics ?? [],
          privateInputValues(Object.values(record.inputs ?? {}))
        );
      this.save(record);
    }
  }

  private async cleanupRecord(
    record: BootstrapRecord,
    bundle: ComposeBundle,
    resources: RunResource[],
    operation: string
  ): Promise<void> {
    const cleaned = await this.orchestrator!.cleanup(bundle, resources);
    cleaned.forEach((resource) => this.repositories?.saveResource(record.runId, resource));
    record.resources = cleaned;
    record.cleanupStatus = cleanupComplete(cleaned) ? "COMPLETE" : "FAILED";
    if (record.cleanupStatus === "COMPLETE")
      this.setReadiness(record, "CLEANED", `${operation} completed`);
    else {
      this.addDiagnostic(record, {
        code: "bootstrap_cleanup_incomplete",
        operation,
        resources: cleaned.map((resource) => ({
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
          cleanupResult: resource.cleanupResult
        }))
      });
    }
    this.save(record);
  }

  private bundleFor(record: BootstrapRecord): ComposeBundle {
    const inputs = record.inputs ?? {};
    const input = (key: string, imageKey: string): string =>
      String(inputs[key] ?? this.imageReference(record, imageKey));
    return generateRunCompose(
      record.runId,
      record.environmentId,
      record.scenario!,
      { db: input("databaseImage", "database"), pas: input("pasImage", "pas") },
      {
        seed: String(inputs.seed ?? ""),
        applicationArchive: String(inputs.applicationArchive ?? ""),
        credentialRef: record.credentialReference,
        dbObserverExecutable: this.openedge?.dbObserverExecutable,
        dbObserverProcedure: this.openedge?.dbObserverProcedure,
        dbObserverArgs: this.openedge?.dbObserverArgs,
        dbObserverRuntimePath: this.openedge?.dbObserverRuntimePath,
        loadgenImage: this.imageReference(record, "loadgen"),
        observerImage: this.imageReference(record, "observer"),
        dbObserverImage: this.openedge?.observerImage
      }
    );
  }

  private imageReference(record: BootstrapRecord, key: string): string {
    const value = record.resolvedImages?.[key];
    if (value && typeof value === "object" && typeof (value as any).reference === "string")
      return (value as any).reference;
    return String(value ?? "");
  }

  private setReadiness(record: BootstrapRecord, state: string, reason: string): void {
    const at = new Date().toISOString();
    record.phase = state;
    record.readiness = {
      state,
      services: record.readiness?.services,
      transitions: [...(record.readiness?.transitions ?? []), { state, at, reason }]
    };
  }

  private addDiagnostic(record: BootstrapRecord, diagnostic: unknown): void {
    const diagnostics = record.diagnostics ?? [];
    if (diagnostics.length < 50) diagnostics.push(diagnostic);
    record.diagnostics = diagnostics;
  }

  private save(record: BootstrapRecord): void {
    record.updatedAt = new Date().toISOString();
    this.repository.save(record);
    this.repositories?.saveEnvironment(record as unknown as Record<string, unknown>);
  }
}

function cleanupComplete(resources: RunResource[]): boolean {
  return resources.every((resource) => resource.cleanupResult === "deleted");
}

function readinessServiceFromError(error: unknown): string | undefined {
  const message = String(error);
  if (!message.includes("run_readiness_timeout")) return undefined;
  return message.split(":").slice(2).join(":") || "readiness";
}
