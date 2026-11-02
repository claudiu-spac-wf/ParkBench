import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeRunName } from "../../packages/contracts/src/matrix-expansion";
import {
  freezeDiagnosticsConfig,
  DIAGNOSTIC_DEFAULTS,
  validateMeasurementEvidence
} from "../../packages/contracts/src/measurement-diagnostics";
function declaration() {
  return {
    contractVersion: "measurement-campaign.v1",
    campaignId: "fixture-campaign",
    mode: "INVESTIGATE",
    state: "DECLARED",
    specRef: "024-fix-measurement-gaps",
    revision: "fixture-revision",
    configurations: [
      {
        configurationId: "read-no-setup",
        workloadClass: "READ_ONLY",
        setup: "NONE",
        scenarioSourceId: "fixture-scenario",
        seedRef: "input:seeds/public",
        archiveRef: "input:archives/public",
        setupRef: null,
        startupParameters: { "-n": 100 },
        phases: { warmupSeconds: 60, measurementSeconds: 180, cooldownSeconds: 30 },
        concurrency: 35,
        cadencesMs: { controller: 5000 },
        deployedRefs: { controller: "fixture-image" },
        triggerConditions: [],
        expectationRefs: ["fixture-inventory"],
        diagnostics: freezeDiagnosticsConfig(undefined, DIAGNOSTIC_DEFAULTS, 0)
      }
    ],
    attempts: [],
    expectationRefs: ["fixture-inventory"],
    findingRefs: [],
    evidenceRefs: ["fixture-prerequisites"],
    createdAtMs: 0,
    updatedAtMs: 0
  };
}
test("generated campaign run names obey the actual API limit and retain a stable distinct suffix", async () => {
  const { campaignRunName } = await import(
    path.resolve("scripts/diagnostics/measurement-campaign.mjs")
  );
  const a = campaignRunName("f024-cost-control-read-csv", "cost-control-read-csv", 1);
  assert.equal(normalizeRunName(a), a);
  assert.ok(a.length <= 48);
  assert.equal(a, campaignRunName("f024-cost-control-read-csv", "cost-control-read-csv", 1));
  assert.notEqual(a, campaignRunName("f024-cost-control-read-csv", "cost-control-read-csv", 2));
  const b = campaignRunName("a".repeat(100), "end_A", 1),
    c = campaignRunName("a".repeat(100), "end-B", 1);
  assert.equal(normalizeRunName(b), b);
  assert.equal(normalizeRunName(c), c);
  assert.notEqual(b, c);
});
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-campaign-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const module: any = await import(path.resolve("scripts/diagnostics/measurement-campaign.mjs"));
  const store = await module.CampaignStore.open(path.join(root, "campaign.json"), {
    root,
    validate: validateMeasurementEvidence
  });
  await store.declare(declaration(), {
    "read-no-setup": {
      contractVersion: "experiment-schedule.v2",
      runName: "fixture-campaign",
      scenarioSourceId: "fixture-scenario",
      inputs: { seed: "input:seeds/public", applicationArchive: "input:archives/public" },
      dimensions: [{ name: "-n", values: [100] }],
      repetitions: 1
    }
  });
  return { root, module, store };
}
test("declarations/configurations are contained and immutable; resume is read only", async (t) => {
  const { root, module, store } = await fixture(t),
    before = await fs.readFile(store.file);
  await assert.rejects(() =>
    module.CampaignStore.open(path.join(root, "../escape.json"), { root })
  );
  await assert.rejects(() => store.declare({ ...declaration(), revision: "changed" }, {}));
  const calls: any[] = [];
  const client = {
    get: async (url: string) => {
      calls.push(url);
      return { items: [], experiments: [] };
    },
    post: () => {
      throw new Error("resume attempted mutation");
    }
  };
  await module.resumeCampaign(store, client);
  assert.deepEqual(await fs.readFile(store.file), before);
});
test("ambiguous submission checkpoints before mutation and read-only resume reconciles the same preview", async (t) => {
  const { module, store } = await fixture(t);
  let created: any,
    submitCalls = 0;
  const mutationKeys: string[] = [];
  const client = {
    get: async (url: string) => {
      if (url === "/api/v1/queue") return { items: [] };
      if (url === "/api/v1/experiments") return { experiments: created ? [created] : [] };
      if (url.includes("/cells"))
        return {
          previewId: "reviewed-preview",
          cellCount: 1,
          runCount: 1,
          cells: {
            items: [
              {
                ordinal: 0,
                repetition: 1,
                effectiveConfiguration: { "-n": 100 },
                measurementDiagnostics: { mode: "summary" }
              }
            ],
            hasMore: false
          }
        };
      if (url.includes("/runs/"))
        return {
          run: {
            id: "owned-run",
            state: "SUCCEEDED",
            measurementValidity: "VALID",
            cleanupStatus: "COMPLETE"
          }
        };
      throw new Error("unexpected GET " + url);
    },
    post: async (url: string, body: any, key: string) => {
      const checkpoint = await store.checkpoint();
      if (url.endsWith("preview"))
        return {
          previewId: "reviewed-preview",
          cellCount: 1,
          runCount: 1,
          cells: { items: [{ ordinal: 0, repetition: 1 }], hasMore: false }
        };
      if (url.endsWith("submit")) {
        submitCalls++;
        mutationKeys.push(key);
        assert.equal(checkpoint.active.submitKey, key);
        assert.equal(checkpoint.active.stage, "SUBMIT_PENDING");
        created = {
          id: "owned-experiment",
          previewId: "reviewed-preview",
          runs: [{ id: "owned-run" }]
        };
        throw new Error("fixture_ambiguous_timeout");
      }
      throw new Error("unexpected POST " + url);
    }
  };
  await assert.rejects(
    () =>
      module.runCampaign(store, client, {
        configuration: "read-no-setup",
        count: 1,
        origin: "FIXTURE"
      }),
    /ambiguous/
  );
  assert.equal(submitCalls, 1);
  const snapshot = await store.checkpoint();
  assert.equal(snapshot.active.stage, "SUBMIT_PENDING");
  client.post = async () => {
    throw new Error("resume must not replay submission or setup");
  };
  await module.resumeCampaign(store, client);
  const reconciled = await store.checkpoint();
  assert.deepEqual(reconciled.active.runIds, ["owned-run"]);
  assert.equal(reconciled.active.submitKey, mutationKeys[0]);
});
test("unrelated queues block before mutation and cancellation is restricted to campaign-owned runs", async (t) => {
  const { module, store } = await fixture(t);
  let posts = 0;
  const client = {
    get: async () => ({ activeExperiment: "someone-else", items: [{ id: "other-run" }] }),
    post: async () => {
      posts++;
      return {};
    }
  };
  await assert.rejects(
    () =>
      module.runCampaign(store, client, {
        configuration: "read-no-setup",
        count: 1,
        origin: "FIXTURE"
      }),
    /unrelated/
  );
  assert.equal(posts, 0);
  await assert.rejects(() => module.cancelCampaignRun(store, client, "other-run"), /owned/);
  assert.equal(posts, 0);
});
test("investigation assessment retains inconclusive attempts and cannot grant final confirmation", async (t) => {
  const { module, store } = await fixture(t);
  const assessment = await module.assessEvidence({
    campaign: await store.read(),
    run: { state: "SUCCEEDED", measurementValidity: "VALID", cleanupStatus: "COMPLETE" },
    diagnostics: { recordingState: "SEALED" },
    sourceAudit: null,
    summaryAudit: null,
    charts: []
  });
  assert.equal(assessment.assessment, "INCONCLUSIVE");
  assert.ok(assessment.reasonCodes.includes("source_audit_missing"));
  assert.equal((await module.verifyCampaign(store)).passed, false);
});
test("a resumed paged review loads every frozen cell before submit/start and preserves the checkpoint keys", async (t) => {
  const { module, store } = await fixture(t),
    calls: string[] = [];
  const checkpoint = await store.checkpoint();
  checkpoint.active = {
    batchId: "fixture-batch",
    configurationId: "read-no-setup",
    count: 2,
    origin: "FIXTURE",
    stage: "REVIEW_PENDING",
    previewId: "paged-review",
    submitKey: "same-submit-key",
    startKey: "same-start-key",
    runIds: []
  };
  await store.saveCheckpoint(checkpoint);
  const client = {
    get: async (url: string) => {
      calls.push("GET " + url);
      if (url === "/api/v1/experiments") return { experiments: [] };
      if (url === "/api/v1/queue") return { items: [] };
      if (url.includes("/cells"))
        return {
          previewId: "paged-review",
          cellCount: 1,
          runCount: 2,
          cells: {
            items: [
              {
                ordinal: 0,
                repetition: url.includes("pageToken") ? 2 : 1,
                effectiveConfiguration: { "-n": 100 },
                measurementDiagnostics: { mode: "summary" }
              }
            ],
            hasMore: !url.includes("pageToken"),
            nextPageToken: !url.includes("pageToken") ? "second" : undefined
          }
        };
      throw new Error("unexpected GET");
    },
    post: async (url: string, _body: any, key: string) => {
      calls.push("POST " + url);
      if (url.endsWith("submit")) {
        assert.ok(calls.filter((c) => c.includes("/cells")).length === 2);
        assert.equal(key, "same-submit-key");
        return { id: "exp", runs: [{ id: "run-1" }, { id: "run-2" }] };
      }
      if (url.endsWith("start")) {
        assert.equal(key, "same-start-key");
        assert.equal((await store.checkpoint()).active.stage, "START_PENDING");
        return {};
      }
      throw new Error("unexpected POST");
    }
  };
  await module.runCampaign(store, client, {
    configuration: "read-no-setup",
    count: 2,
    origin: "FIXTURE",
    wait: false
  });
  assert.equal((await store.checkpoint()).active.stage, "STARTED");
});
test("campaign uses the existing preview/submit/queue/history/artifact APIs and retains a fixture assessment", async (t) => {
  const { root, module } = await fixture(t);
  const { createPlatform } = await import("../../apps/control-plane/src/platform"),
    { buildServer } = await import("../../apps/control-plane/src/server"),
    { ScenarioFileSource } = await import("../../apps/control-plane/src/catalog/scenario-source");
  const scenarios = path.resolve("tests/fixtures/simplify-run-workflow/scenarios"),
    source = new ScenarioFileSource(scenarios)
      .list()
      .find((s) => s.declaredScenarioId === "disk-scenario")!;
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: path.join(root, "artifacts"),
      prometheusUrl: "http://fixture",
      prometheusRetention: "7d",
      measurementDiagnostics: DIAGNOSTIC_DEFAULTS,
      discoveryRoots: { scenarios },
      openedge: {}
    } as any,
    { testMode: true, phaseScale: 0 }
  );
  const app = buildServer(platform);
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await platform.startupRecovery;
  await platform.discoveryReady;
  const declared: any = declaration();
  declared.configurations[0].scenarioSourceId = source.id;
  const store = await module.CampaignStore.open(path.join(root, "api-campaign.json"), {
    root,
    validate: validateMeasurementEvidence
  });
  await store.declare(declared, {
    "read-no-setup": {
      contractVersion: "experiment-schedule.v2",
      runName: "api-campaign",
      scenarioSourceId: source.id,
      inputs: { seed: "input:seeds/public", applicationArchive: "input:archives/public" },
      dimensions: [{ name: "-n", values: [100] }],
      repetitions: 1
    }
  });
  const before = await fs.readFile(store.file);
  const client = {
    get: async (url: string) => {
      const r = await app.inject({ method: "GET", url });
      assert.ok(r.statusCode < 400, `${url}: ${r.statusCode}`);
      return r.json();
    },
    post: async (url: string, body: any, key: string) => {
      const r = await app.inject({
        method: "POST",
        url,
        payload: body,
        headers: { "idempotency-key": key }
      });
      assert.ok(r.statusCode < 400, `${url}: ${r.statusCode}`);
      return r.json();
    }
  };
  const checkpoint = await module.runCampaign(store, client, {
    configuration: "read-no-setup",
    count: 1,
    origin: "FIXTURE",
    pollMs: 250
  });
  assert.equal(checkpoint.active.stage, "TERMINAL");
  assert.equal(checkpoint.active.runIds.length, 1);
  const assessed = await module.assessCampaign(store, client);
  assert.equal(assessed.attempts.length, 1);
  assert.equal(assessed.attempts[0].origin, "FIXTURE");
  assert.notEqual(assessed.attempts[0].assessment, "ACCEPTED");
  const read = await store.read();
  assert.equal(read.attempts.length, 1);
  assert.deepEqual(await fs.readFile(store.file), before);
  const unchanged = await module.assessCampaign(store, client);
  assert.equal(unchanged.attempts.length, 0);
});
test("live investigation requires an immutable discriminating batch declaration before scheduling", async (t) => {
  const { module, store } = await fixture(t);
  let posts = 0;
  const client = {
    get: async () => ({ items: [] }),
    post: async () => {
      posts++;
      throw new Error("fixture_stop_before_submission");
    }
  };
  await assert.rejects(
    () => module.runCampaign(store, client, { configuration: "read-no-setup", count: 1 }),
    /hypothesis_declaration_required/
  );
  assert.equal(posts, 0);
  const hypothesis = {
    contractVersion: "measurement-hypothesis-batch.v1",
    hypothesisId: "H1",
    campaignRevision: "fixture-revision",
    configurationIds: ["read-no-setup"],
    supportingObservationRefs: ["run:public-baseline"],
    discriminatingTestRef: "timing-control",
    controlRef: "unchanged-load",
    intendedChangeRef: "trace-mode-only",
    requiredEvidenceRefs: ["stage-timing"],
    observedConditionRefs: ["idle"],
    nextDecisionRule: "Compare source capture and dispatch delays before selecting a repair."
  };
  assert.deepEqual(await store.declareHypothesis(hypothesis), {
    hypothesisId: "H1",
    state: "DECLARED"
  });
  await assert.rejects(() =>
    store.declareHypothesis({ ...hypothesis, intendedChangeRef: "changed" })
  );
  await assert.rejects(
    () =>
      module.runCampaign(store, client, {
        configuration: "read-no-setup",
        count: 1,
        hypothesisRef: "H1",
        intendedChangeRef: "changed"
      }),
    /hypothesis_configuration_mismatch/
  );
  assert.equal(posts, 0);
});

test("inventory reads startup names from the deployed versioned options envelope", async () => {
  const module: any = await import(path.resolve("scripts/diagnostics/measurement-campaign.mjs"));
  assert.deepEqual(
    module.databaseParameterNames({
      databaseParameters: {
        contractVersion: "database-parameter-options.v2",
        parameters: [{ name: "-n" }, { name: "-B" }]
      }
    }),
    ["-n", "-B"]
  );
});
