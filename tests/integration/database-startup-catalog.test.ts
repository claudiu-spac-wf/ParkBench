import { generateRunCompose } from "../../packages/compose-runner/src/run-compose";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectSeedStartupFile } from "../../packages/compose-runner/src/input-checks";
import { resolveDatabaseStartup } from "../../packages/contracts/src/matrix-expansion";
import {
  databaseParameterOptions,
  validateDatabaseParameterConfiguration,
  validateDatabaseParameterPaths,
  databaseParameterTokens
} from "../../packages/contracts/src/database-parameter-options";
import { parameterPlan, readParameterPlan } from "../../packages/compose-runner/src/parameters";
import { deriveDatabaseParameterSnapshot } from "../../packages/observers/src/openedge-db/parameter-snapshot";
import { validateScenarioDatabaseParameterDefinitions } from "../../apps/control-plane/src/catalog/scenario-validation";
const caps = databaseParameterOptions({ version: "12.8.11", features: ["enterprise"] });
test("expands controlled PFs with native precedence and rejects traversal, cycles and managed bypasses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-catalog-pf-"));
  try {
    fs.writeFileSync(path.join(root, "nested.pf"), '-spin 2 -diagPrefix "literal space"\n');
    fs.writeFileSync(path.join(root, "startup.pf"), "-B 500\n-pf nested.pf\n-B 750\n");
    const inspection = inspectSeedStartupFile(root);
    const startup = resolveDatabaseStartup(
      { ...inspection, entries: inspection.parsed.entries },
      { "-B": 1000 },
      { "-B": 1500 }
    );
    assert.equal(startup.parameters.find((p) => p.name === "-B")?.displayValue, "1500");
    assert.equal(
      startup.parameters.find((p: any) => p.name === "-diagPrefix")?.displayValue,
      "literal space"
    );
    assert.ok(startup.registryVersion);
    for (const bad of ["-pf ../escape.pf", "-S 22222", "-pf startup.pf"]) {
      fs.writeFileSync(path.join(root, "startup.pf"), bad);
      assert.throws(() => inspectSeedStartupFile(root), /database_startup_file_invalid/);
    }
    fs.writeFileSync(path.join(root, "startup.pf"), "-pf link.pf");
    fs.symlinkSync("/etc/hosts", path.join(root, "link.pf"));
    assert.throws(() => inspectSeedStartupFile(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("new typed forms preserve literal values, false semantics, native bounds, dependencies and scopes", () => {
  const values = {
    "-diagPrefix": "literal space",
    "-diagFS": " ",
    "-ipver": "ipv4",
    "-threadedServer": false,
    "-ssj": false,
    "-schlockwq": false
  };
  validateDatabaseParameterConfiguration(values, caps);
  const plan = parameterPlan(values);
  assert.deepEqual(plan.databaseStartupArgs, [
    "-diagPrefix",
    "literal space",
    "-diagFS",
    " ",
    "-ipver",
    "IPv4",
    "-threadedServer",
    "0",
    "-ssj",
    "0"
  ]);
  assert.equal(plan.databaseEnvironment.PARKBENCH_OPENEDGE_DB_STARTUP_WORDS, undefined);
  assert.throws(() => validateDatabaseParameterConfiguration({ "-B": 100, "-n": 10001 }, caps));
  assert.throws(
    () => validateDatabaseParameterConfiguration({ "-lgTruncateFrequency": 1 }, caps),
    /dependency/
  );
  assert.throws(
    () =>
      validateDatabaseParameterConfiguration({ "-clstmtcachedir": "x", "-clstmtCacheDir": "y" }),
    /duplicate/
  );
  assert.throws(
    () => validateDatabaseParameterConfiguration({ "-SQLStack": 256 }, caps),
    /verified sql/
  );
  assert.throws(() => parameterPlan({ "-S": "22222" }), /ownership/);
  assert.throws(
    () => validateDatabaseParameterPaths({ "-T": "/tmp/foreign" }, "parkbench"),
    /ownership/
  );
  assert.doesNotThrow(() =>
    validateDatabaseParameterPaths({ "-T": "/psc/wrk/parkbench/literal spaces" }, "parkbench")
  );
  assert.deepEqual(databaseParameterTokens("-ssj", false), ["-ssj", "0"]);
});
test("scenario definitions may narrow but cannot widen native bounds, increments or capability", () => {
  const definition: any = {
    id: "locks",
    canonicalName: "-L",
    type: "integer",
    minimum: 32,
    maximum: 3200,
    step: 32,
    description: "Locks",
    source: "scenario",
    matrixAllowed: true,
    secret: false,
    definitionVersion: "1"
  };
  assert.doesNotThrow(() =>
    validateScenarioDatabaseParameterDefinitions([definition], { version: "12.8.11" })
  );
  assert.throws(
    () =>
      validateScenarioDatabaseParameterDefinitions([{ ...definition, step: 1 }], {
        version: "12.8.11"
      }),
    /widened/
  );
  assert.throws(
    () =>
      validateScenarioDatabaseParameterDefinitions([{ ...definition, canonicalName: "-ecsize" }], {
        version: "12.8.11"
      }),
    /unavailable/
  );
});
test("retained v1 plans are read without new catalog rewriting or false-value emission", () => {
  const frozen: any = {
    contractVersion: "parameters.v1",
    databaseStartupArgs: ["-B", "1"],
    databaseEnvironment: { DB_NAME: "parkbench" },
    pasEnvironment: {},
    resourceLimits: {},
    databaseMetricsEnabled: true,
    databaseLatencyMs: 0
  };
  const before = JSON.stringify(frozen);
  assert.deepEqual(readParameterPlan(frozen).databaseStartupArgs, ["-B", "1"]);
  assert.equal(JSON.stringify(frozen), before);
});
test("native typed verification uses observed data and leaves absent/unreportable values unverified", () => {
  const startup = resolveDatabaseStartup(
    { startupFile: { status: "absent" }, entries: [] },
    {},
    { "-threadedServer": false, "-ipver": "IPv4", "-diagPrefix": "literal space" }
  );
  const capture: any = {
    contractVersion: "openedge-db-parameter-capture.v1",
    databaseName: "parkbench",
    attemptedAt: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    status: "complete",
    source: "_DbParams",
    rows: [
      { name: "-threadedServer", rawValue: "0", dtype: 4, isDefault: false },
      { name: "-ipver", rawValue: "IPv4", dtype: 1, isDefault: false }
    ]
  };
  const result = deriveDatabaseParameterSnapshot(
    capture,
    { runId: "run", experimentId: "exp", variantId: "v", repetition: 1 },
    startup
  );
  assert.equal(
    result.verificationResults.find((r) => r.name === "-threadedServer")?.verification,
    "matched"
  );
  assert.equal(
    result.verificationResults.find((r) => r.name === "-ipver")?.verification,
    "matched"
  );
  assert.equal(
    result.verificationResults.find((r) => r.name === "-diagPrefix")?.verification,
    "unverifiable"
  );
});

import { runControlFixture } from "../helpers/run-controls";
import { validateExperimentRequest } from "../../packages/compose-runner/src/preflight";
test("daily and nonzero log truncation both require a time without changing false flag emission", async () => {
  const { platform, document } = runControlFixture();
  try {
    await platform.startupRecovery;
    const request = (parameters: any): any => ({
      scenario: { id: document.id, version: document.version },
      comparisonMode: "exploratory",
      repetitions: 1,
      variants: [{ id: "v", name: "v", parameters }],
      inputs: {
        databaseImage: "db:fixture",
        pasImage: "pas:fixture",
        seed: "input:seed/fixture",
        applicationArchive: "input:archive/fixture"
      }
    });
    const options = {
      databaseCapabilities: { version: "12.8.11", features: ["enterprise"] },
      diskIo: { cadvisor: true, nodeExporterBlockDevice: true }
    };
    for (const frequency of [0, 1, 8]) {
      const unpaired = { "-lgTruncateFrequency": frequency };
      assert.throws(() => validateDatabaseParameterConfiguration(unpaired, caps), /dependency/);
      assert.throws(
        () => validateExperimentRequest(request(unpaired), document, options),
        /dependency/
      );
      assert.throws(
        () => platform.coordinator.createExperiment(request(unpaired), document),
        /dependency/
      );
      const paired = { ...unpaired, "-lgTruncateTime": "03:00" };
      assert.doesNotThrow(() => validateExperimentRequest(request(paired), document, options));
      assert.doesNotThrow(() => platform.coordinator.createExperiment(request(paired), document));
    }
    assert.deepEqual(databaseParameterTokens("-schlockwq", false), []);
    assert.deepEqual(databaseParameterTokens("-ssj", false), ["-ssj", "0"]);
  } finally {
    platform.close();
  }
});
test("fresh scheduling verifies supplied PF metadata and frozen argv never reopens changed files", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-fresh-pf-"));
  const root = path.join(parent, "seed");
  fs.mkdirSync(root);
  const { platform, document } = runControlFixture({ inputRoot: parent });
  try {
    await platform.startupRecovery;
    fs.writeFileSync(path.join(root, "nested.pf"), "-spin 3\n");
    fs.writeFileSync(path.join(root, "extra.pf"), "-B 1000\n-pf nested.pf\n");
    // A seed descriptor requires database files; use the same minimal fixture layout as the seed checks.
    for (const name of ["parkbench.db", "parkbench.b1", "parkbench.d1"])
      fs.writeFileSync(path.join(root, name), "fixture");
    fs.writeFileSync(path.join(root, "parkbench.st"), "b .\nd .\n");
    const pf = "/run/parkbench/seed/db/extra.pf";
    const parameters = { "-pf": pf, "-B": 1500 };
    const inspected = inspectSeedStartupFile(root, [pf]);
    const startup = resolveDatabaseStartup(
      { ...inspected, entries: inspected.parsed.entries },
      {},
      parameters
    );
    const request: any = {
      scenario: { id: document.id, version: document.version },
      comparisonMode: "exploratory",
      repetitions: 1,
      variants: [{ id: "v", name: "v", parameters, databaseStartup: startup }],
      inputs: {
        databaseImage: "db:fixture",
        pasImage: "pas:fixture",
        seed: root,
        applicationArchive: "input:archive/fixture"
      }
    };
    const options = {
      inputRoot: root,
      databaseCapabilities: { version: "12.8.11", features: ["enterprise"] },
      diskIo: { cadvisor: true, nodeExporterBlockDevice: true }
    };
    assert.doesNotThrow(() => validateExperimentRequest(request, document, options));
    const reviewed = platform.controlUi.preview({
      runName: "pf-preview",
      scenario: request.scenario,
      dimensions: [],
      fixedOverrides: parameters,
      repetitions: 1,
      inputs: { seed: root, applicationArchive: "input:archive/fixture" }
    });
    assert.equal(
      reviewed.cells.items[0].databaseStartup?.parameters.find((p) => p.name === "-spin")
        ?.displayValue,
      "3"
    );
    platform.controlUi.submit({ previewId: reviewed.previewId, confirm: true });
    const direct = platform.coordinator.createExperiment(request, document);
    const frozen: any = platform.repositories.getRun(direct.runIds[0])!.environmentSnapshot;
    const serialized = JSON.stringify(frozen);
    for (const invalid of ["-S 22222", "-pf ../escape.pf", "-pf missing.pf"]) {
      fs.writeFileSync(path.join(root, "extra.pf"), invalid);
      assert.throws(
        () => validateExperimentRequest(request, document, options),
        /database_startup_file/
      );
      assert.throws(
        () => platform.coordinator.createExperiment(request, document),
        /database_startup_file/
      );
    }
    fs.rmSync(path.join(root, "extra.pf"));
    assert.throws(
      () => platform.coordinator.createExperiment(request, document),
      /database_startup_file/
    );
    const bundle = generateRunCompose(
      "pf-replay",
      "experiment",
      document,
      { db: "db:fixture", pas: "pas:fixture" },
      {
        ...request.inputs,
        databaseStartup: frozen.databaseStartup,
        parameters: frozen.variant.parameters
      }
    );
    assert.match(bundle.brokerArgv, /-B\n1500\n/);
    assert.match(bundle.brokerArgv, /-spin\n3\n/);
    assert.doesNotMatch(bundle.brokerArgv, /-pf/);
    assert.equal(JSON.stringify(frozen), serialized);
    assert.doesNotThrow(() =>
      validateExperimentRequest({ ...request, variants: [frozen.variant] }, document, {
        ...options,
        frozenDatabaseStartup: true
      })
    );
    const fabricated = { ...startup, expandedParameterFiles: undefined };
    assert.throws(
      () =>
        generateRunCompose(
          "pf-invalid",
          "experiment",
          document,
          { db: "db:fixture", pas: "pas:fixture" },
          { ...request.inputs, databaseStartup: fabricated, parameters }
        ),
      /controlled_pf_expansion/
    );
  } finally {
    platform.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
test("evidenced aliases schedule canonically and real alias duplicates conflict", async () => {
  const { platform, document } = runControlFixture();
  try {
    await platform.startupRecovery;
    const request: any = {
      scenario: { id: document.id, version: document.version },
      comparisonMode: "exploratory",
      repetitions: 1,
      variants: [
        { id: "v", name: "v", parameters: { "-clstmtCacheDir": "/psc/wrk/parkbench/cache" } }
      ],
      inputs: {
        databaseImage: "db:fixture",
        pasImage: "pas:fixture",
        seed: "input:seed/fixture",
        applicationArchive: "input:archive/fixture"
      }
    };
    const previewRequest: any = {
      runName: "alias-catalog",
      scenario: request.scenario,
      dimensions: [],
      fixedOverrides: request.variants[0].parameters,
      repetitions: 1
    };
    const preview = platform.controlUi.preview(previewRequest);
    const submitted = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
    const direct = platform.coordinator.createExperiment(request, document);
    for (const id of [submitted.runs[0].id, direct.runIds[0]]) {
      const frozen: any = platform.repositories.getRun(id)!.environmentSnapshot;
      assert.equal(
        frozen.variant.databaseStartup.parameters.filter((p: any) => p.name === "-clstmtcachedir")
          .length,
        1
      );
      assert.equal(frozen.variant.parameters["-clstmtCacheDir"], undefined);
    }
    const canonicalStartup = platform.repositories.getRun(direct.runIds[0])!.environmentSnapshot
      .databaseStartup as any;
    const aliasStartup = {
      ...canonicalStartup,
      parameters: canonicalStartup.parameters.map((p: any) => ({
        ...p,
        name: p.name === "-clstmtcachedir" ? "-clstmtCacheDir" : p.name
      }))
    };
    assert.doesNotThrow(() =>
      platform.coordinator.createExperiment(
        { ...request, variants: [{ ...request.variants[0], databaseStartup: aliasStartup }] },
        document
      )
    );
    assert.doesNotThrow(() =>
      validateExperimentRequest(request, document, {
        databaseCapabilities: { version: "12.8.11" },
        diskIo: { cadvisor: true, nodeExporterBlockDevice: true }
      })
    );
    const sweep = platform.controlUi.preview({
      ...previewRequest,
      fixedOverrides: {},
      dimensions: [{ name: "-clstmtCacheDir", values: ["/psc/wrk/parkbench/cache"] }]
    });
    assert.equal(sweep.cells.items[0].values["-clstmtcachedir"], "/psc/wrk/parkbench/cache");
    for (const value of ["/psc/wrk/parkbench/cache", "/psc/wrk/parkbench/other"]) {
      const duplicates = {
        "-clstmtCacheDir": "/psc/wrk/parkbench/cache",
        "-clstmtcachedir": value
      };
      assert.throws(
        () => platform.controlUi.preview({ ...previewRequest, fixedOverrides: duplicates }),
        /duplicate/
      );
      assert.throws(
        () =>
          platform.coordinator.createExperiment(
            { ...request, variants: [{ ...request.variants[0], parameters: duplicates }] },
            document
          ),
        /duplicate/
      );
    }
    assert.throws(
      () =>
        platform.controlUi.preview({
          ...previewRequest,
          dimensions: [{ name: "-clstmtcachedir", values: ["/psc/wrk/parkbench/cache"] }]
        }),
      /matrix_override_conflict/
    );
  } finally {
    platform.close();
  }
});
test("scenario narrowing applies to fixed/swept previews, direct scheduling and preflight before records are created", async () => {
  const { platform, document } = runControlFixture();
  try {
    await platform.startupRecovery;
    const base = { ...document.parameterDefinitions[0], defaultValue: undefined };
    document.parameterDefinitions = [
      { ...base, maximum: 100, step: 10, defaultValue: 20 },
      { ...base, id: "bi", canonicalName: "-bibufs", minimum: 64, maximum: 128, step: 64 },
      {
        ...base,
        id: "apw",
        canonicalName: "database.apwCount",
        minimum: 0,
        maximum: 4,
        step: 2,
        dependencies: [{ parameter: "-B", operator: "gte", value: 20 }]
      },
      {
        ...base,
        id: "cluster",
        canonicalName: "database.biClusterSizeMiB",
        type: "number",
        minimum: 0.5,
        maximum: 1,
        step: 0.5
      },
      {
        ...base,
        id: "biw",
        canonicalName: "database.biwEnabled",
        type: "boolean",
        minimum: undefined,
        maximum: undefined,
        allowedValues: [false]
      }
    ];
    document.version = "1.1.0";
    platform.scenarios.register(document);
    const request = (parameters: any): any => ({
      scenario: { id: document.id, version: document.version },
      comparisonMode: "exploratory",
      repetitions: 1,
      variants: [{ id: "v", name: "v", parameters }],
      inputs: {
        databaseImage: "db:fixture",
        pasImage: "pas:fixture",
        seed: "input:seed/fixture",
        applicationArchive: "input:archive/fixture"
      }
    });
    const preview = (parameters: any, swept = false) =>
      platform.controlUi.preview({
        runName: "narrowed",
        scenario: request({}).scenario,
        dimensions: swept
          ? Object.entries(parameters).map(([name, value]) => ({ name, values: [value as any] }))
          : [],
        fixedOverrides: swept ? {} : parameters,
        repetitions: 1
      });
    const options = {
      databaseCapabilities: { version: "12.8.11", features: ["enterprise"] },
      diskIo: { cadvisor: true, nodeExporterBlockDevice: true }
    };
    for (const [values, error] of [
      [{ "-B": 200 }, /parameter_above_maximum/],
      [{ "-B": 11 }, /parameter_step/],
      [{ "-bibufs": 192 }, /parameter_above_maximum/],
      [{ "database.apwCount": 3 }, /parameter_step/],
      [{ "database.biClusterSizeMiB": 0.75 }, /parameter_step/],
      [{ "database.biwEnabled": true }, /parameter_value_not_allowed/],
      [{ "-B": 10, "database.apwCount": 2 }, /dependency_not_satisfied/]
    ] as const) {
      assert.throws(() => preview(values), error);
      assert.throws(() => preview(values, true), error);
      assert.throws(() => platform.coordinator.createExperiment(request(values), document), error);
      assert.throws(() => validateExperimentRequest(request(values), document, options), error);
    }
    const accepted = {
      "-B": 100,
      "-bibufs": 128,
      "database.apwCount": 4,
      "database.biClusterSizeMiB": 1,
      "database.biwEnabled": false
    };
    assert.doesNotThrow(() => validateExperimentRequest(request(accepted), document, options));
    const reviewed = preview(accepted);
    const submitted = platform.controlUi.submit({ previewId: reviewed.previewId, confirm: true });
    const frozen = JSON.stringify(
      platform.repositories.getRun(submitted.runs[0].id)!.environmentSnapshot
    );
    document.parameterDefinitions[0].maximum = 50;
    document.version = "2.0.0";
    platform.scenarios.register(document);
    assert.throws(() => preview(accepted), /parameter_above_maximum/);
    assert.equal(
      JSON.stringify(platform.repositories.getRun(submitted.runs[0].id)!.environmentSnapshot),
      frozen
    );
  } finally {
    platform.close();
  }
});
test("preview, submit, direct scheduling and preflight share typed catalog validation and freeze accepted metadata", async () => {
  const { platform, document } = runControlFixture();
  try {
    await platform.startupRecovery;
    const request = (parameters: Record<string, unknown>): any => ({
      scenario: { id: document.id, version: document.version },
      comparisonMode: "exploratory",
      repetitions: 1,
      variants: [{ id: "v", name: "Variant", parameters }],
      inputs: {
        databaseImage: `db:fixture@sha256:${"0123456789abcdef".repeat(4)}`,
        pasImage: `pas:fixture@sha256:${"abcdef0123456789".repeat(4)}`,
        seed: "input:seed/fixture",
        applicationArchive: "input:archive/fixture"
      }
    });
    for (const invalid of [
      { "-B": 9 },
      { "-ssj": true, "-threadedServer": false },
      { "-T": "/tmp/foreign" },
      { "-diagPrefix": "bad\nvalue" },
      { "-S": "22222" }
    ]) {
      assert.throws(() =>
        platform.controlUi.preview({
          runName: "invalid-catalog",
          scenario: { id: document.id, version: document.version },
          dimensions: [],
          fixedOverrides: invalid,
          repetitions: 1
        })
      );
      assert.throws(() => platform.coordinator.createExperiment(request(invalid), document));
      assert.throws(() =>
        validateExperimentRequest(request(invalid), document, {
          databaseCapabilities: { version: "12.8.11", features: ["enterprise"] }
        })
      );
    }
    const values = {
      "-diagPrefix": "literal space",
      "-ipver": "ipv4",
      "-threadedServer": false,
      "-ssj": false,
      "-bibufs": 64
    };
    const preview = platform.controlUi.preview({
      runName: "frozen-catalog",
      scenario: { id: document.id, version: document.version },
      dimensions: [],
      fixedOverrides: values,
      repetitions: 1
    });
    const submitted = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
    const metadata = platform.controlRepository.getRunMetadata(submitted.runs[0].id)!;
    const frozen = JSON.stringify(metadata.snapshot);
    const direct = platform.coordinator.createExperiment(request(values), document);
    const variant = platform.repositories.getRun(direct.runIds[0])!.environmentSnapshot!
      .variant as any;
    assert.equal(
      variant.databaseStartup?.parameters.find((p: any) => p.name === "-ssj")?.displayValue,
      "false"
    );
    assert.equal(
      variant.databaseStartup?.parameters.find((p: any) => p.name === "-diagPrefix")?.displayValue,
      "literal space"
    );
    values["-diagPrefix"] = "changed";
    platform.scenarios.register({ ...document, version: "2.0.0" });
    assert.equal(
      JSON.stringify(platform.controlRepository.getRunMetadata(submitted.runs[0].id)!.snapshot),
      frozen
    );
  } finally {
    platform.close();
  }
});

test("hash latch factor previews fixed and swept values and freezes broker argv without starting runs", async () => {
  const { runControlFixture } = await import("../helpers/run-controls");
  const { platform, document } = runControlFixture();
  try {
    await platform.startupRecovery;
    const request = {
      runName: "hash-latch-factor",
      scenario: { id: document.id, version: document.version },
      repetitions: 1
    };
    const fixed = platform.controlUi.preview({
      ...request,
      dimensions: [],
      fixedOverrides: { "-hashLatchFactor": 10 }
    });
    const startup = fixed.cells.items[0].databaseStartup!;
    assert.equal(startup.parameters.find((p) => p.name === "-hashLatchFactor")?.displayValue, "10");
    assert.deepEqual(parameterPlan({ "-hashLatchFactor": 10 }).databaseStartupArgs, [
      "-hashLatchFactor",
      "10"
    ]);
    const swept = platform.controlUi.preview({
      ...request,
      dimensions: [{ name: "-hashLatchFactor", values: [5, 100] }]
    });
    assert.deepEqual(
      swept.cells.items.map(
        (cell) =>
          cell.databaseStartup!.parameters.find((p) => p.name === "-hashLatchFactor")!.displayValue
      ),
      ["5", "100"]
    );
    for (const value of [4, 101])
      assert.throws(
        () =>
          platform.controlUi.preview({
            ...request,
            dimensions: [],
            fixedOverrides: { "-hashLatchFactor": value }
          }),
        /parameter_(below_minimum|above_maximum)/
      );
    assert.deepEqual(
      platform.repositories.listExperiments(),
      [],
      "fixture preview creates no experiments"
    );
  } finally {
    platform.close();
  }
});
