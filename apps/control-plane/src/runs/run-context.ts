import fs from "node:fs";
import crypto from "node:crypto";
import type { Run } from "../../../../packages/contracts/src/run";
import { RunContext, validateRunContext } from "../../../../packages/contracts/src/run-summary";
import { redactSecrets, runtimeSecretValues } from "../../../../packages/contracts/src/redaction";
import { validateBenchmarkImageManifest } from "../../../../packages/contracts/src/openedge-validation";
import { ArtifactStorage } from "../artifacts/storage";
import { Repositories } from "../db/repositories";
import { artifactRecord } from "../artifacts/manifest";
export function buildRunContext(run: Run, final = false): RunContext {
  const e = (run.environmentSnapshot as any) ?? {},
    images: any = {
      configured: {
        database: e.inputs?.databaseImage,
        pas: e.inputs?.pasImage,
        observer: e.inputs?.observerImage
      },
      resolved: run.imageSnapshots ?? e.resolvedImages ?? {}
    };
  if (e.openedgeImageManifestPath && fs.existsSync(e.openedgeImageManifestPath)) {
    const size = fs.statSync(e.openedgeImageManifestPath).size;
    if (size > 1024 * 1024) throw new Error("run_context_manifest_limit_exceeded");
    images.manifest = validateBenchmarkImageManifest(
      JSON.parse(fs.readFileSync(e.openedgeImageManifestPath, "utf8"))
    );
  }
  const context: RunContext = {
    contractVersion: "run-context.v1",
    runId: run.id,
    scenario: e.scenario ?? {},
    requested: e.requestedConfiguration ?? {
      parameters: e.variant?.parameters ?? {},
      databaseStartup: e.variant?.databaseStartup ?? {},
      ...(e.databaseRunControls ? { databaseRunControls:e.databaseRunControls } : {}),
      inputs: e.inputs ?? {}
    },
    effective: {
      parameters: e.effectiveConfiguration ?? {},
      databaseStartup: e.databaseStartup ?? {},
      ...(e.databaseRunControls ? { databaseRunControls:e.databaseRunControls } : {}),
      adapterVersion: e.parameterAdapterVersion
    },
    observed: {
      ...Object.fromEntries(
        Object.entries(e).filter(
          ([key]) =>
            ![
              "scenario",
              "inputs",
              "inputProvenance",
              "variant",
              "effectiveConfiguration",
              "databaseStartup",
              "parameterAdapterVersion",
              "resolvedImages",
              "deterministicLoadSeed",
              "createdAt",
              "contextCapturedAt",
              "requestedConfiguration"
            ].includes(key)
        )
      ),
      phaseBoundaries: run.phaseBoundaries ?? {},
      state: run.state,
      measurementValidity: run.measurementValidity,
      cleanupStatus: run.cleanupStatus,
      seedCopySeconds: e.seedCopySeconds,
      loadgenExitCode: e.loadgenExitCode,
      metrics: e.metrics,
      completeness: run.completeness,
      failureKind: run.failureKind,
      failureCode: run.failureCode,
      failureReason: run.failureReason
    },
    inputs: { ...e.inputs, provenance: e.inputProvenance ?? [] },
    loadSeed: e.deterministicLoadSeed ?? e.scenario?.workload?.load?.seed ?? 1,
    host: e.hostDocker ?? {},
    tools: { node: process.version, parameterAdapterVersion: e.parameterAdapterVersion },
    images,
    sources: [
      {
        contracts: e.metricContracts ?? {},
        cadences: e.sourceCadences ?? {},
        acquisition: "native explicit capture timestamps; uncached cAdvisor housekeeping"
      }
    ],
    capturedAt: e.contextCapturedAt ?? e.createdAt ?? run.startedAt ?? new Date().toISOString(),
    health: run.observerHealth ?? {},
    parameterReference: e.parameterSnapshotCapture ?? { state: "not_collected" },
    diagnostics: { failureReason: run.failureReason, ...e.summaryDiagnostics }
  };
  if (final) context.finalizedAt = new Date().toISOString();
  const safe = redactSecrets(context, runtimeSecretValues()) as RunContext;
  validateRunContext(safe, run.id);
  return safe;
}
export function persistRunContext(
  run: Run,
  storage: ArtifactStorage,
  repositories: Repositories,
  final = false
) {
  const context = buildRunContext(run, final),
    path = `${run.id}/run-context.v1.json`,
    file = storage.writeAtomic(path, JSON.stringify(context)),
    record = {
      ...artifactRecord(run.id, "run_context", file, "json", {
        contractVersion: context.contractVersion
      }),
      id: "context_" + Buffer.from(run.id).toString("base64url")
    };
  repositories.saveArtifact(record);
  return record;
}
