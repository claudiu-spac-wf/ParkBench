import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform, testObserverFactory } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import { classifyRunError } from "../../apps/control-plane/src/runs/run-error";
import workScenario from "../../examples/scenarios/parkbench-bank-mix.json";
import crudScenario from "../../examples/scenarios/crud-rest.json";
import { syntheticImageManifest } from "../helpers/openedge";
import { createSeedFixture } from "../helpers/seed";

async function checkStaticObserverFailure(failure: "contract" | "image" | "support-image") {
  fs.mkdirSync(path.join(process.cwd(), ".parkbench"), { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(process.cwd(), ".parkbench", "static-observer-"));
  const seed = createSeedFixture(path.join(fixtureRoot, "seeds"));
  const applicationArchive = path.join(fixtureRoot, "runner.zip");
  const manifestPath = path.join(fixtureRoot, "manifest.json");
  fs.writeFileSync(applicationArchive, "runner-archive-fixture");
  const manifest = syntheticImageManifest("final");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const orchestrator = new FakeRunOrchestrator();
  const delegatedFactory = testObserverFactory();
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: path.join(fixtureRoot, "artifacts"),
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {
        imageManifestPath: manifestPath,
        ...(failure === "image" ? { observerImage: "parkbench/openedge-observer:mismatch" } : {})
      }
    },
    {
      testMode: true,
      orchestrator,
      phaseScale: 0,
      requiredDiskIo: false,
      ...(failure === "support-image"
        ? { supportImages: { loadgen: "parkbench/loadgen:fixture", observer: "parkbench/observer:fixture" } }
        : {}),
      observerFactory: {
        validate(declaration: any) {
          if (failure === "contract" && declaration.kind === "openedge_db_v1")
            throw new Error("observer_contract_invalid:private diagnostic");
          delegatedFactory.validate?.(declaration);
        },
        create(declaration: any, context: any) {
          return delegatedFactory.create(declaration, context);
        }
      }
    }
  );
  try {
    await platform.startupRecovery;
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: workScenario.id, version: workScenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "baseline", name: "Baseline", parameters: {} }],
        inputs: {
          databaseImage: manifest.db.reference,
          pasImage: manifest.pasoe.reference,
          seed,
          applicationArchive
        }
      } as any,
      workScenario as any
    );
    const run = platform.repositories.getRun(experiment.runIds[0])!;
    assert.equal(experiment.status, failure === "support-image" ? "QUEUED" : "FAILED");
    if (failure === "support-image") {
      assert.equal(run.failureKind, undefined);
      assert.equal(run.failureCode, undefined);
    } else {
      assert.equal(run.failureKind, "observer");
      assert.equal(
        run.failureCode,
        failure === "contract" ? "observer_contract_invalid" : "observer_image_mismatch"
      );
    }
    assert.ok((run.failureReason?.length ?? 0) <= 512);
    assert.doesNotMatch(run.failureReason ?? "", /private diagnostic|\.parkbench/);
    assert.deepEqual(platform.repositories.listResources(run.id), []);
    assert.deepEqual(orchestrator.calls, []);
  } finally {
    platform.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

class FailedReadyOrchestrator extends FakeRunOrchestrator {
  constructor(private readonly readinessError: string) {
    super();
  }

  override async waitForReady(): Promise<void> {
    this.calls.push("ready");
    throw new Error(this.readinessError);
  }
}

async function checkRuntimeReadinessFailure(
  code: "pas_readiness_failed" | "database_readiness_failed" | "database_schema_invalid"
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-readiness-failure-"));
  const orchestrator = new FailedReadyOrchestrator(`${code}:probe`);
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {}
    },
    {
      testMode: true,
      orchestrator,
      phaseScale: 0,
      requiredDiskIo: false
    }
  );
  try {
    await platform.startupRecovery;
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: crudScenario.id, version: crudScenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "baseline", name: "Baseline", parameters: {} }],
        inputs: {
          databaseImage:
            "db:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          pasImage:
            "pas:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      } as any,
      crudScenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.equal(run.state, "FAILED");
    assert.equal(run.failureKind, "infrastructure");
    assert.equal(run.failureCode, code);
    assert.ok((run.failureReason?.length ?? 0) <= 512);
    assert.equal(run.phaseBoundaries?.measurement, undefined);
    assert.equal(orchestrator.calls.includes("start-workload"), false);
    assert.equal(orchestrator.calls.includes("wait-workload"), false);
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("typed run failure contract", () => {
  it("maps observer contract and image mismatches to bounded observer failures", () => {
    const contract = classifyRunError(new Error("observer_contract_invalid:secret-value"));
    const image = classifyRunError(new Error("observer_image_mismatch:/private/path"));
    assert.deepEqual(
      { kind: contract?.failureKind, code: contract?.failureCode },
      { kind: "observer", code: "observer_contract_invalid" }
    );
    assert.deepEqual(
      { kind: image?.failureKind, code: image?.failureCode },
      { kind: "observer", code: "observer_image_mismatch" }
    );
    assert.equal(JSON.stringify(contract).includes("secret-value"), false);
    assert.equal(JSON.stringify(image).includes("/private/path"), false);
  });

  it("classifies schema rejection separately from readiness timeout", () => {
    assert.equal(
      classifyRunError(new Error("database_schema_invalid:field_Customer_Name_invalid"))
        ?.failureCode,
      "database_schema_invalid"
    );
    assert.equal(
      classifyRunError(new Error("run_readiness_timeout:database_schema_readiness"))?.failureCode,
      "database_readiness_timeout"
    );
    assert.equal(
      classifyRunError(new Error("run_readiness_timeout:pas-2:/parkbench/web/health"))?.failureCode,
      "pas_readiness_timeout"
    );
  });

  it("classifies a full run root before provisioning", () => {
    assert.equal(
      classifyRunError(new Error("insufficient_disk_space:run_root"))?.failureCode,
      "insufficient_disk_space"
    );
  });

  it("persists static observer rejection before any run resources are provisioned", async () => {
    await checkStaticObserverFailure("contract");
    await checkStaticObserverFailure("image");
  });

  it("does not compare the OpenEdge observer to the generic support observer image", async () => {
    await checkStaticObserverFailure("support-image");
  });

  it("fails typed runtime readiness before starting measurement or workload traffic", async () => {
    await checkRuntimeReadinessFailure("pas_readiness_failed");
    await checkRuntimeReadinessFailure("database_readiness_failed");
    await checkRuntimeReadinessFailure("database_schema_invalid");
  });

  it("persists the closed failure code in run storage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-run-error-"));
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: root,
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    try {
      await platform.startupRecovery;
      const run: any = {
        id: "run-error-contract",
        experimentId: "exp-error-contract",
        variantId: "baseline",
        repetition: 1,
        state: "FAILED",
        measurementValidity: "UNAVAILABLE",
        composeProject: "parkbench-run-error-contract",
        resourceNamespace: {},
        cleanupStatus: "COMPLETE",
        failureKind: "infrastructure",
        failureCode: "database_schema_invalid",
        failureReason: "the run-owned database does not satisfy the workload's declared schema"
      };
      platform.repositories.saveExperiment({
        id: run.experimentId,
        scenario: { id: "parkbench-bank-mix", version: "1.0.0" },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "baseline", name: "Baseline", parameters: {} }],
        inputs: { databaseImage: "db:fixture", pasImage: "pas:fixture" },
        status: "FAILED",
        runIds: [],
        createdAt: new Date(0).toISOString()
      } as any);
      platform.repositories.saveRun(run);
      assert.equal(platform.repositories.getRun(run.id)?.failureCode, "database_schema_invalid");
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
