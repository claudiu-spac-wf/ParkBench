import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";

const implementation = import(path.resolve("scripts/diagnostics/measurement-acceptance.mjs"));

test("verify CLI reopens run proofs through its selected API base URL", async (t) => {
  const module = await import(path.resolve("scripts/diagnostics/measurement-campaign.mjs"));
  const c: any = campaign();
  // This check is about API routing; no deployment or live scheduler is involved.
  c.mode = "INVESTIGATE";
  c.createdAtMs = 0;
  c.evidenceRefs = [];
  const store = {
    root: os.tmpdir(),
    directory: path.join(os.tmpdir(), "absent-campaign-state"),
    read: async () => c
  };
  t.mock.method(module.CampaignStore, "open", async () => store);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ error: { code: "fixture_missing" } }), { status: 404 });
  });
  const result = await module.main([
    "verify",
    "--campaign",
    "fixture.json",
    "--base-url",
    "http://127.0.0.1:19876"
  ]);
  assert.equal(result.passed, false);
  assert.equal(requests.length, 5);
  assert.ok(requests.every((url) => url.startsWith("http://127.0.0.1:19876/api/v1/history/runs/")));
});

test("verification rejects reversed lifecycle timestamps even when every linked stage is present", async (t) => {
  const { verifyCampaign } = await import(
    path.resolve("scripts/diagnostics/measurement-campaign.mjs")
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-transition-proof-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "campaign.state");
  await fs.mkdir(path.join(directory, "transitions"), { recursive: true });
  const c: any = campaign();
  c.mode = "INVESTIGATE";
  c.createdAtMs = 0;
  c.evidenceRefs = [];
  c.attempts = [
    { ...c.attempts[0], previewRef: "preview", submitKey: "submit", startKey: "start" }
  ];
  let terminalFile = "";
  for (const [i, toStage] of ["SUBMITTED", "START_PENDING", "STARTED", "TERMINAL"].entries()) {
    const file = path.join(directory, "transitions", randomUUID() + ".json");
    const record = {
      contractVersion: "measurement-campaign-transition.v1",
      recordedAtMs: (i + 1) * 100,
      toStage,
      reasonCode: "fixture_progress",
      links: {
        runIds: [c.attempts[0].runId],
        previewId: "preview",
        submitKey: "submit",
        startKey: "start"
      }
    };
    await fs.writeFile(file, JSON.stringify(record));
    if (toStage === "TERMINAL") terminalFile = file;
  }
  const store = { root, directory, read: async () => c };
  const client = {
    get: async () => {
      throw Error("No native evidence in this transition fixture");
    }
  };
  const valid = await verifyCampaign(store, client);
  assert.ok(!valid.reasonCodes.includes("transition_evidence_unavailable"));
  const terminal = JSON.parse(await fs.readFile(terminalFile, "utf8"));
  terminal.recordedAtMs = 150;
  await fs.writeFile(terminalFile, JSON.stringify(terminal));
  const reversed = await verifyCampaign(store, client);
  assert.ok(reversed.reasonCodes.includes("transition_evidence_unavailable"));
});

test("screenshot evidence requires a complete PNG with intact chunk data", async () => {
  const { validateScreenshotPng } = await implementation;
  // A complete one-pixel RGBA PNG, including compressed scanline and chunk CRCs.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
    "base64"
  );
  assert.equal(validateScreenshotPng(png), true);
  for (let length = 0; length < png.length; length++)
    assert.throws(() => validateScreenshotPng(png.subarray(0, length)), /acceptance_screenshot_/);
  const corrupt = Buffer.from(png);
  corrupt[45] ^= 1;
  assert.throws(() => validateScreenshotPng(corrupt), /acceptance_screenshot_crc/);
  assert.throws(
    () => validateScreenshotPng(Buffer.concat([png, Buffer.from([0])])),
    /acceptance_screenshot_end/
  );
  assert.throws(
    () => validateScreenshotPng(Buffer.alloc(8 * 1024 ** 2 + 1)),
    /acceptance_screenshot_png/
  );
});

test("chart re-audits select one current capture per panel and verification preserves the accepted references", async (t) => {
  const { chartEvidence } = await import(
    path.resolve("scripts/diagnostics/measurement-campaign.mjs")
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-chart-proof-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
    "base64"
  );
  const window = {
    startedAt: new Date(1000).toISOString(),
    finishedAt: new Date(2000).toISOString()
  };
  const write = async (name: string, recordedAtMs: number, extra = {}) => {
    const directory = path.join(root, "charts", `chart-fresh-${name}`);
    await fs.mkdir(directory, { recursive: true });
    const screenshot = path.join(directory, "panel.png"),
      inspectorScreenshot = path.join(directory, "inspector.png");
    await fs.writeFile(screenshot, png);
    await fs.writeFile(inspectorScreenshot, png);
    const record = {
      runId: "fresh",
      dashboardUid: "affected",
      panelId: "1",
      startMs: 1000,
      endMs: 2000,
      phase: "measurement",
      timezone: "UTC",
      origin: "LIVE",
      recordedAtMs,
      complete: true,
      screenshot,
      inspectorScreenshot,
      ...extra
    };
    const file = path.join(directory, "capture.json");
    await fs.writeFile(file, JSON.stringify(record));
    return { ref: path.relative(root, file), screenshot };
  };
  const first = await write("first", 1);
  const newer = await write("newer", 2);
  const wrongWindow = await write("wrong-window", 3, { startMs: 0 });
  const assessed = await chartEvidence({ root }, "fresh", window);
  assert.deepEqual(assessed.refs, [newer.ref]);
  assert.ok(assessed.superseded.includes(first.ref));
  assert.ok(assessed.superseded.includes(wrongWindow.ref));
  const pinned = await chartEvidence({ root }, "fresh", window, [first.ref]);
  assert.deepEqual(pinned.refs, [first.ref]);
  // Expiry of a superseded screenshot must not invalidate the retained proof.
  await fs.rm(first.screenshot);
  assert.deepEqual((await chartEvidence({ root }, "fresh", window)).refs, [newer.ref]);
  await fs.writeFile(newer.screenshot, png.subarray(0, 8));
  await assert.rejects(() => chartEvidence({ root }, "fresh", window), /acceptance_screenshot_png/);
});
function campaign() {
  const configurations = [
    ["read-no-setup", "READ_ONLY", "NONE"],
    ["read-setup", "READ_ONLY", "ORDERED"],
    ["mixed-no-setup", "MIXED", "NONE"],
    ["mixed-setup", "MIXED", "ORDERED"]
  ].map(([configurationId, workloadClass, setup]) => ({ configurationId, workloadClass, setup }));
  const attempts = configurations.flatMap((c, index) =>
    Array.from({ length: index === 0 ? 2 : 1 }, (_, i) => ({
      runId: `${c.configurationId}-${i}`,
      configurationId: c.configurationId,
      origin: "LIVE",
      assessment: "ACCEPTED",
      revision: "r2",
      runState: "SUCCEEDED",
      measurementValidity: "VALID",
      cleanupState: "COMPLETE",
      diagnosticCompleteness: "COMPLETE",
      sourceAuditRefs: ["source.json"],
      summaryAuditRefs: ["summary.json"],
      chartRefs: ["chart.json"],
      reasonCodes: []
    }))
  );
  return { mode: "CONFIRM", revision: "r2", configurations, attempts };
}
test("four base combinations need five independently audited fresh base passes", async () => {
  const { confirmationSequences } = await implementation;
  const c = campaign();
  assert.equal(confirmationSequences(c).passed, true);
  c.attempts.pop();
  const result = confirmationSequences(c);
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.includes("minimum_five_base_missing"));
  assert.equal(result.sequences["mixed-setup"], 0);
});
test("failure and inconclusive attempts reset a sequence; total green count does not replace consecutive evidence", async () => {
  const { confirmationSequences } = await implementation;
  for (const assessment of ["REJECTED", "INCONCLUSIVE"]) {
    const c = campaign();
    c.attempts.push({
      ...c.attempts[0],
      configurationId: "mixed-setup",
      runId: "failed",
      assessment
    });
    assert.equal(confirmationSequences(c).sequences["mixed-setup"], 0);
    assert.equal(confirmationSequences(c).passed, false);
  }
});
test("old revisions, historical runs, faults, fixtures, controls and duplicate run IDs cannot count", async () => {
  const { confirmationSequences } = await implementation;
  for (const origin of ["HISTORICAL", "FAULT", "FIXTURE", "CONTROL"]) {
    const c = campaign();
    c.attempts[2].origin = origin;
    assert.equal(confirmationSequences(c).passed, false);
  }
  const old = campaign();
  old.attempts[2].revision = "r1";
  assert.equal(confirmationSequences(old).passed, false);
  const duplicate = campaign();
  duplicate.attempts[2].runId = duplicate.attempts[1].runId;
  assert.equal(confirmationSequences(duplicate).passed, false);
});
test("extra configurations require their own three passes and missing base combinations fail", async () => {
  const { confirmationSequences } = await implementation;
  const extra = campaign();
  extra.configurations.push({
    configurationId: "actual-trigger",
    workloadClass: "READ_ONLY",
    setup: "NONE"
  });
  assert.equal(confirmationSequences(extra).passed, false);
  const missing = campaign();
  missing.configurations[3].setup = "NONE";
  assert.ok(
    confirmationSequences(missing).reasonCodes.includes("base_configuration_missing:MIXED:ORDERED")
  );
});
test("complete state and links are required even for a caller-labelled accepted attempt", async () => {
  const { confirmationSequences } = await implementation;
  for (const override of [
    { cleanupState: "PENDING" },
    { diagnosticCompleteness: "INCOMPLETE" },
    { sourceAuditRefs: [] },
    { summaryAuditRefs: [] },
    { chartRefs: [] },
    { reasonCodes: ["gap"] }
  ]) {
    const c = campaign();
    Object.assign(c.attempts[2], override);
    assert.equal(confirmationSequences(c).passed, false);
  }
});

test("native coverage distinguishes complete zero activity, missing source intervals and scoped unavailability", async () => {
  const { nativeIdentityCovered } = await implementation;
  const zero = {
    metric: "parkbench_openedge_db_table_operations_total",
    dimensions: { table: "Account" },
    available: 36,
    unavailable: 0,
    samples: 36,
    availabilityCoverage: { missingSeconds: 0 },
    coverage: { missingSeconds: 0 },
    missingAvailableValues: 0,
    unexpectedValueTimes: 0
  };
  assert.equal(nativeIdentityCovered(zero), true);
  assert.equal(
    nativeIdentityCovered({ ...zero, coverage: { missingSeconds: 5 }, complete: true }),
    false
  );
  assert.equal(
    nativeIdentityCovered({ ...zero, missingAvailableValues: 1, complete: true }),
    false
  );
  assert.equal(
    nativeIdentityCovered({ ...zero, availabilityCoverage: { missingSeconds: 5 } }),
    false
  );
  const disabled = {
    ...zero,
    metric: "parkbench_openedge_db_buffer_pool_configured_buffers",
    dimensions: { pool: "alternate" },
    independentAvailability: "not_configured",
    independentReason: "alternate_pool_disabled",
    available: 0,
    unavailable: 36,
    samples: 0,
    coverage: null,
    limitation: "alternate_pool_disabled",
    unavailabilityReasons: ["alternate_pool_disabled"]
  };
  assert.equal(nativeIdentityCovered(disabled), true);
  assert.equal(nativeIdentityCovered({ ...disabled, dimensions: { pool: "primary" } }), false);
  assert.equal(nativeIdentityCovered({ ...disabled, independentReason: "field_missing" }), false);
  const dynamic = {
    ...zero,
    metric: "parkbench_openedge_db_transaction_oldest_active_age_seconds",
    available: 20,
    unavailable: 16,
    samples: 20,
    coverage: { missingSeconds: 80 },
    limitation: "time_scoped_not_applicable",
    unavailabilityReasons: ["not_applicable"]
  };
  assert.equal(nativeIdentityCovered(dynamic), true);
  assert.equal(nativeIdentityCovered({ ...dynamic, missingAvailableValues: 1 }), false);
  assert.equal(nativeIdentityCovered({ ...dynamic, metric: zero.metric }), false);
});

test("CSV parsing preserves zeros, null cells, quoted names and newlines and refuses truncation", async () => {
  const { parseComparisonCsv } = await implementation;
  assert.deepEqual(parseComparisonCsv('run_id,metric,average,p95\nrun1,"A,""B""\nC",0,\n'), [
    { run_id: "run1", metric: 'A,"B"\nC', average: "0", p95: "" }
  ]);
  assert.throws(() => parseComparisonCsv('run_id,metric\nrun1,"truncated'));
  assert.throws(() => parseComparisonCsv("run_id,metric\nrun1"));
});

test("assessment cannot accept caller booleans, incomplete producers, missing panels or an optional supported gap", async () => {
  const { assessEvidence } = await import(
    path.resolve("scripts/diagnostics/measurement-campaign.mjs")
  );
  const config = {
    configurationId: "read",
    setup: "NONE",
    phases: { warmupSeconds: 1, measurementSeconds: 1, cooldownSeconds: 1 },
    concurrency: 1,
    startupParameters: { "-n": 100 },
    seedRef: "input:seeds/public",
    cadencesMs: { core: 1000, "openedge-db": 1000 },
    deployedRefs: { "control-plane": "image" },
    diagnostics: {
      mode: "summary",
      summaryLimitBytes: 100,
      traceLimitBytes: 100,
      pendingLimitBytes: 100,
      eventLimitBytes: 100,
      flushIntervalMs: 100
    }
  };
  const boundary = (start: number) => ({
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date(start + 1000).toISOString()
  });
  const run = {
    id: "fresh",
    state: "SUCCEEDED",
    measurementValidity: "VALID",
    cleanupStatus: "COMPLETE",
    completeness: { complete: true, requiredGaps: [] },
    phaseBoundaries: { warmup: boundary(0), measurement: boundary(1000), cooldown: boundary(2000) },
    environmentSnapshot: {
      scenario: { phases: config.phases, workload: { load: { concurrency: 1 } } },
      effectiveConfiguration: { "-n": 100 },
      inputs: { seedName: "public" },
      sourceCadences: {
        prometheusScrapeSeconds: 1,
        nativeDatabaseRefreshSeconds: 1,
        observers: [
          { id: "core", stepSeconds: 1 },
          { id: "openedge-db", stepSeconds: 1 }
        ]
      }
    }
  };
  const diagnostic = {
    recordingState: "SEALED",
    inventoryIncomplete: false,
    findingsIncomplete: false,
    droppedEvents: 0,
    writeFailures: 0,
    config: config.diagnostics,
    deployedRefs: config.deployedRefs,
    producers: ["controller", "metadata", "db-observer", "file-sampler", "pas-observer"].map(
      (component) => ({
        component,
        collectionStatus: "COMPLETE",
        flushState: "COMPLETE",
        budgetAccountingState: "CONFIRMED",
        droppedEvents: 0,
        droppedMetadataRecords: 0,
        writeFailures: 0,
        unconfirmedEvents: 0
      })
    )
  };
  const source = {
    contractVersion: "measurement-source-audit.v1",
    runId: "fresh",
    revision: "r2",
    startMs: 1000,
    endMs: 2000,
    inventoryEvidenceRef: "inventory",
    inventoryCount: 1,
    assessedCount: 1,
    gapCount: 0,
    identities: [
      {
        metric: "public_counter",
        dimensions: {},
        available: 1,
        unavailable: 0,
        samples: 1,
        availabilityCoverage: { missingSeconds: 0 },
        coverage: { missingSeconds: 0 },
        missingAvailableValues: 0,
        unexpectedValueTimes: 0
      }
    ],
    requiredPanels: [
      {
        dashboardUid: "affected",
        panelId: "1",
        queries: [
          {
            refId: "A",
            datasourceUid: "parkbench-runs",
            templateDigest: "a".repeat(64),
            sourceScope: "RUN"
          }
        ]
      }
    ]
  };
  const summary = {
    contractVersion: "measurement-summary-audit.v1",
    runId: "fresh",
    startMs: 1000,
    endMs: 2000,
    savedDigest: "digest",
    savedRowCount: 1,
    assessedRowCount: 1,
    mismatches: [],
    unassessedRows: [],
    unsupportedGaps: [],
    missingMembers: [],
    membershipMismatches: [],
    comparison: {
      comparisonId: "comparison",
      comparisonRowCount: 1,
      csvRowCount: 1,
      csvDigest: "digest",
      comparisonMismatches: [],
      csvMismatches: []
    }
  };
  const chart = {
    contractVersion: "measurement-chart-capture.v1",
    runId: "fresh",
    dashboardUid: "affected",
    panelId: "1",
    phase: "measurement",
    startMs: 1000,
    endMs: 2000,
    timezone: "UTC",
    origin: "LIVE",
    complete: true,
    screenshot: "panel.png",
    inspectorScreenshot: "inspector.png",
    viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
    inspector: { executed: true, startMs: 1000, endMs: 2000, queryCount: 1, refIds: ["A"] },
    queries: [
      {
        refId: "A",
        kind: "RANGE",
        stepMs: 1000,
        requestedStartMs: 1000,
        requestedEndMs: 2000,
        sourceEvidenceComplete: true,
        queryId: "query",
        queryMode: "EVALUATION_GRID",
        datasourceUid: "parkbench-runs",
        templateDigest: "a".repeat(64),
        sourceMetadata: {
          contractVersion: "measurement-chart-query.v1",
          runIds: ["fresh"],
          incomplete: false
        }
      }
    ]
  };
  const input = {
    campaign: { mode: "CONFIRM", revision: "r2" },
    configuration: config,
    run,
    diagnostics: diagnostic,
    sourceAudit: source,
    summaryAudit: summary,
    charts: [chart],
    origin: "LIVE"
  };
  assert.equal((await assessEvidence(input)).assessment, "ACCEPTED");
  const globalDeclaration = {
    refId: "A",
    datasourceUid: "prometheus",
    templateDigest: "b".repeat(64),
    selectorsDigest: "c".repeat(64),
    sourceScope: "GLOBAL_PLATFORM"
  };
  const globalQuery = {
    ...chart.queries[0],
    datasourceUid: "prometheus",
    templateDigest: globalDeclaration.templateDigest,
    templateRef: "affected:1:1:A",
    effectiveStartMs: 1000,
    effectiveEndMs: 2000,
    sourceMetadata: {
      contractVersion: "measurement-chart-query.v1",
      runIds: [],
      incomplete: false,
      mode: "unscoped",
      queryMode: "EVALUATION_GRID",
      requestedStartMs: 1000,
      requestedEndMs: 2000,
      stepMs: 1000,
      seriesCount: 1,
      evaluationPointCount: 2
    },
    globalContext: {
      contractVersion: "measurement-global-chart-context.v1",
      sourceScope: "GLOBAL_PLATFORM",
      runId: "fresh",
      phase: "measurement",
      dashboardUid: "affected",
      dashboardVersion: 1,
      panelId: "1",
      refId: "A",
      startMs: 1000,
      endMs: 2000,
      effectiveStartMs: 1000,
      effectiveEndMs: 2000,
      templateDigest: globalDeclaration.templateDigest,
      selectorsDigest: globalDeclaration.selectorsDigest,
      expressionDigest: "d".repeat(64)
    }
  };
  const globalInput = {
    ...input,
    sourceAudit: {
      ...source,
      requiredPanels: [{ dashboardUid: "affected", panelId: "1", queries: [globalDeclaration] }]
    },
    charts: [{ ...chart, queries: [globalQuery] }]
  };
  // Global platform readings are bound to the audited phase and generated
  // query; they must retain their truthful empty run-label ownership.
  assert.equal((await assessEvidence(globalInput)).assessment, "ACCEPTED");
  const emptyQuery = {
    ...globalQuery,
    sourceMetadata: {
      ...globalQuery.sourceMetadata,
      seriesCount: 0,
      evaluationPointCount: 0
    }
  };
  const emptyInput = { ...globalInput, charts: [{ ...chart, queries: [emptyQuery] }] };
  assert.notEqual((await assessEvidence(emptyInput)).assessment, "ACCEPTED");
  const platformKey = "platform:cadvisor:" + "a".repeat(64);
  const availability = {
    contractVersion: "measurement-global-availability.v1",
    runId: "fresh",
    startMs: 1000,
    endMs: 2000,
    reason: "memory_limit_not_configured",
    sourceSelector:
      'container_spec_memory_limit_bytes{job="cadvisor",container_label_com_docker_compose_project="parkbench-platform",container_label_com_docker_compose_service!=""}',
    unexpectedSamples: 0,
    members: [{ key: platformKey, samples: 1, nonzeroSamples: 0, missingSeconds: 0 }]
  };
  const eligibleInput = {
    ...emptyInput,
    diagnostics: {
      ...diagnostic,
      deployedRefs: { ...diagnostic.deployedRefs, [platformKey]: "image" }
    },
    sourceAudit: {
      ...globalInput.sourceAudit,
      globalAvailability: availability,
      requiredPanels: [
        {
          dashboardUid: "affected",
          panelId: "1",
          queries: [{ ...globalDeclaration, emptyRule: "memory_limit_not_configured" }]
        }
      ]
    }
  };
  assert.equal((await assessEvidence(eligibleInput)).assessment, "ACCEPTED");
  for (const broken of [
    undefined,
    { ...availability, members: [] },
    { ...availability, startMs: 1500 },
    { ...availability, runId: "foreign" },
    { ...availability, unexpectedSamples: 1 },
    ...[{ nonzeroSamples: 1 }, { samples: 0 }, { missingSeconds: 0.1 }].map((change) => ({
      ...availability,
      members: [{ ...availability.members[0], ...change }]
    }))
  ]) {
    assert.notEqual(
      (
        await assessEvidence({
          ...eligibleInput,
          sourceAudit: {
            ...eligibleInput.sourceAudit,
            globalAvailability: broken
          }
        })
      ).assessment,
      "ACCEPTED"
    );
  }
  for (const override of [
    { globalContext: undefined },
    { globalContext: { ...globalQuery.globalContext, runId: "foreign" } },
    { globalContext: { ...globalQuery.globalContext, endMs: 3000 } },
    { globalContext: { ...globalQuery.globalContext, selectorsDigest: "e".repeat(64) } },
    { templateDigest: "e".repeat(64) },
    { sourceMetadata: { ...globalQuery.sourceMetadata, incomplete: true } },
    { sourceMetadata: { ...globalQuery.sourceMetadata, runIds: ["foreign"] } },
    {
      sourceMetadata: { ...globalQuery.sourceMetadata, runIds: ["fresh"] },
      globalContext: undefined
    }
  ])
    assert.notEqual(
      (
        await assessEvidence({
          ...globalInput,
          charts: [{ ...chart, queries: [{ ...globalQuery, ...override }] }]
        })
      ).assessment,
      "ACCEPTED"
    );
  for (const override of [
    { sourceAudit: { complete: true } },
    {
      sourceAudit: {
        ...source,
        identities: [{ ...source.identities[0], coverage: { missingSeconds: 1 }, complete: true }]
      }
    },
    { summaryAudit: { ...summary, unsupportedGaps: ["supported_optional"] } },
    { summaryAudit: { ...summary, comparison: undefined } },
    { charts: [] },
    { diagnostics: { ...diagnostic, producers: diagnostic.producers.slice(1) } },
    { diagnostics: { ...diagnostic, droppedEvents: 1 } },
    {
      charts: [
        {
          ...chart,
          queries: [
            {
              ...chart.queries[0],
              sourceMetadata: { ...chart.queries[0].sourceMetadata, incomplete: true }
            }
          ]
        }
      ]
    },
    { origin: "CONTROL" }
  ])
    assert.notEqual((await assessEvidence({ ...input, ...override })).assessment, "ACCEPTED");
});

test("five labelled passes cannot verify without retained proofs or against a different running build", async (t) => {
  const { verifyCampaign } = await import(
    path.resolve("scripts/diagnostics/measurement-campaign.mjs")
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-confirmation-proof-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const c: any = campaign();
  c.createdAtMs = 0;
  c.evidenceRefs = [];
  for (const config of c.configurations)
    config.deployedRefs = { "control-plane": "intended-image" };
  const store = {
    root,
    directory: path.join(root, "campaign.state"),
    read: async () => c,
    saveCheckpoint: () => {
      throw Error("insufficient proof must not change state");
    }
  };
  const result = await verifyCampaign(
    store,
    {
      get: async () => {
        throw Error("missing real run evidence");
      }
    },
    {
      inspectDeployment: async () => ({
        members: [{ state: "running" }],
        deployedRefs: { "control-plane": "different-image" }
      })
    }
  );
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.includes("final_deployment_mismatch"));
  assert.ok(result.reasonCodes.includes("transition_evidence_unavailable"));
  assert.equal(
    result.reasonCodes.filter((r: string) => r.startsWith("accepted_evidence_unavailable:")).length,
    5
  );
  assert.ok(result.reasonCodes.includes("gate_missing:causal"));
});
