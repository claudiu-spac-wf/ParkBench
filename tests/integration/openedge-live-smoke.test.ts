import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  validateRunContext,
  validateSummaryHeader
} from "../../packages/contracts/src/run-summary";
import { validateDatabaseParameterSnapshot } from "../../packages/contracts/src/database-parameter-snapshot";

const liveEnabled = Boolean(process.env.PARKBENCH_RUN_OPENEDGE_TESTS);
const matrix = JSON.parse(
  fs.readFileSync("tests/fixtures/openedge-12.8/compatibility-matrix.json", "utf8")
);
const localMatrixConfigs = readLocalMatrixConfigs();
const verifiedLiveRunIds = new Map<string, string[]>();

describe("OpenEdge ParkBench live smoke", () => {
  it(
    "runs baseline and variant through Compose and verifies evidence before cleanup",
    { skip: !liveEnabled },
    () => {
      const configPath = process.env.PARKBENCH_OPENEDGE_LIVE_CONFIG ?? ".env.local";
      const scenarioPath =
        process.env.PARKBENCH_OPENEDGE_LIVE_SCENARIO ??
        "examples/scenarios/parkbench-bank-mix.json";
      assert.equal(fs.existsSync(configPath), true, `config_missing:${configPath}`);
      assert.equal(fs.existsSync(scenarioPath), true, `scenario_missing:${scenarioPath}`);

      const command = path.resolve("dist/apps/control-plane/src/commands/smoke.js");
      assert.equal(fs.existsSync(command), true, `compiled_smoke_missing:${command}`);
      const output = execFileSync(
        process.execPath,
        [command, "--openedge", "--config", configPath, "--scenario", scenarioPath],
        {
          encoding: "utf8",
          env: process.env,
          timeout: Number(process.env.PARKBENCH_OPENEDGE_SMOKE_TIMEOUT_MS ?? 900_000)
        }
      );
      const experiment = JSON.parse(output);
      assert.equal(Array.isArray(experiment.runs), true);
      assert.deepEqual(experiment.runs.map((run: any) => run.variantId).sort(), [
        "baseline",
        "variant"
      ]);

      const fileValues = readEnvFile(configPath);
      const hostDataRoot = path.resolve(
        process.env.PARKBENCH_HOST_DATA_ROOT ?? fileValues.PARKBENCH_HOST_DATA_ROOT ?? ".parkbench"
      );
      const artifactRoot = path.resolve(
        process.env.PARKBENCH_ARTIFACT_ROOT ??
          fileValues.PARKBENCH_ARTIFACT_ROOT ??
          ".parkbench/artifacts"
      );
      for (const run of experiment.runs) {
        assert.equal(run.state, "SUCCEEDED");
        assert.equal(run.cleanupStatus, "COMPLETE");
        const { context, summary } = readCurrentArtifacts(artifactRoot, run);
        assert.equal((context.images.manifest as any).imageStage, "final");
        assert.equal((context.images.manifest as any).parkBenchReady, true);
        const workload = summary.workload as any;
        assert.ok(Number(workload.requests.completed) > 0);
        assert.equal(workload.requests.errors, 0);
        assert.equal(workload.timeoutCount, 0);
        assert.equal(summary.quality.complete, true);
        assert.equal(context.observed.cleanupStatus, "COMPLETE");
        const patch = observedPatch(run);
        assert.ok(
          matrix.releases.some((release: any) => release.release === patch),
          `unlisted_openedge_patch:${patch}`
        );
        verifiedLiveRunIds.set(patch, [...(verifiedLiveRunIds.get(patch) ?? []), run.id]);
        const hostEnvironment = context.host?.hostEnvironment as any;
        assert.equal(hostEnvironment?.contractVersion, "host-environment.v1");
        assert.ok(Date.parse(hostEnvironment?.capturedAt ?? ""));
        assert.equal(hostEnvironment?.engine?.reachable, true);
        assert.equal(hostEnvironment?.engine?.operatingSystem, "linux");
        assert.equal(hostEnvironment?.engine?.architecture, "amd64");
        assert.equal(hostEnvironment?.path, "host-environment.json");
        const hostProfilePath = path.join(hostDataRoot, hostEnvironment.path);
        assert.equal(fs.existsSync(hostProfilePath), true, "host_environment_profile_missing");
        // Run series stay in Prometheus; the evidence records where to find them.
        assert.ok(summary.metricsReference.source, `metrics_reference_missing:${run.id}`);
        assert.ok(summary.windows.measurement.start);
        assert.ok(summary.windows.measurement.end);
        assert.equal(
          fs.existsSync(path.join(artifactRoot, run.id, "raw-prometheus.jsonl.gz")),
          false
        );

        const values = context.effective.parameters as Record<string, unknown>;
        assert.equal(values.scenario, "parkbench-bank-mix");
        assert.equal(values.scenarioVersion, "1.0.0");
        assert.deepEqual(
          Object.keys(values).filter((key) => key !== "scenario" && key !== "scenarioVersion"),
          run.variantId === "baseline" ? [] : ["-B"]
        );
        if (run.variantId === "variant") assert.equal(values["-B"], 10000);
      }
      writeCompatibilityResults(verifiedLiveRunIds);
    }
  );

  it(
    "runs one licensed smoke for every additional patch config supplied locally",
    { skip: !liveEnabled || localMatrixConfigs.length === 0, timeout: 1_800_000 },
    () => {
      const command = path.resolve("dist/apps/control-plane/src/commands/smoke.js");
      for (const { release, configPath } of localMatrixConfigs) {
        assert.ok(
          matrix.releases.some((entry: any) => entry.release === release),
          `unlisted_openedge_patch:${release}`
        );
        const output = execFileSync(
          process.execPath,
          [
            command,
            "--openedge",
            "--config",
            configPath,
            "--scenario",
            process.env.PARKBENCH_OPENEDGE_LIVE_SCENARIO ??
              "examples/scenarios/parkbench-bank-mix.json"
          ],
          {
            encoding: "utf8",
            env: process.env,
            timeout: Number(process.env.PARKBENCH_OPENEDGE_SMOKE_TIMEOUT_MS ?? 900_000)
          }
        );
        const experiment = JSON.parse(output);
        assert.deepEqual(experiment.runs.map((run: any) => run.variantId).sort(), [
          "baseline",
          "variant"
        ]);
        const values = readEnvFile(configPath);
        const artifactRoot = path.resolve(
          process.env.PARKBENCH_ARTIFACT_ROOT ??
            values.PARKBENCH_ARTIFACT_ROOT ??
            ".parkbench/artifacts"
        );
        for (const run of experiment.runs) {
          assert.equal(run.state, "SUCCEEDED");
          assert.equal(run.cleanupStatus, "COMPLETE");
          const { context, summary } = readCurrentArtifacts(artifactRoot, run);
          assert.equal(observedPatch(run), release);
          assert.equal(summary.quality.complete, true);
          assert.equal(context.observed.cleanupStatus, "COMPLETE");
          verifiedLiveRunIds.set(release, [...(verifiedLiveRunIds.get(release) ?? []), run.id]);
        }
      }
      writeCompatibilityResults(verifiedLiveRunIds);
    }
  );
});

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function readLocalMatrixConfigs(): Array<{ release: string; configPath: string }> {
  const fileValues = fs.existsSync(".env.local") ? readEnvFile(".env.local") : {};
  const values = { ...fileValues, ...process.env } as Record<string, string | undefined>;
  return Object.entries(values)
    .flatMap(([key, configPath]) => {
      const match = key.match(/^PARKBENCH_OPENEDGE_LIVE_CONFIG_(\d+_\d+_\d+)$/);
      if (!match || !configPath) return [];
      return [{ release: match[1].replaceAll("_", "."), configPath }];
    })
    .sort((left, right) => left.release.localeCompare(right.release));
}

function writeCompatibilityResults(verified: Map<string, string[]>): void {
  const output = path.resolve(".parkbench/openedge/live-compatibility-results.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        schemaVersion: "openedge-12.8-live-results.v1",
        recordedAt: new Date().toISOString(),
        releases: matrix.releases.map((release: any) => ({
          release: release.release,
          fixtureStatus: release.fixture.status,
          liveStatus: verified.has(release.release) ? "verified" : "not_supplied",
          runIds: verified.get(release.release) ?? []
        }))
      },
      null,
      2
    )
  );
}

function observedPatch(run: any): string {
  assert.equal(run.nativeRuntime?.protocolVersion, 3);
  const match = /^([0-9]+\.[0-9]+\.[0-9]+)\./.exec(run.nativeRuntime?.productVersion ?? "");
  assert.ok(match, `native_runtime_identity_missing:${run.id}`);
  return match[1];
}

function readCurrentArtifacts(root: string, run: any) {
  assert.ok(run.validation?.contextPath && run.validation?.summaryPath);
  const context = JSON.parse(fs.readFileSync(path.join(root, run.validation.contextPath), "utf8"));
  const { rows, ...summary } = JSON.parse(
    fs.readFileSync(path.join(root, run.validation.summaryPath), "utf8")
  );
  validateRunContext(context, run.id);
  validateSummaryHeader(summary, run.id);
  assert.equal(rows.length, summary.totalRowCount);
  assert.ok(summary.totalRowCount > 0);
  const records = rows.find(
    (row: any) => row.definitionId === "db.records.read" && row.group === "database"
  );
  assert.ok(records, `native_database_measurement_missing:${run.id}`);
  assert.equal(records.rateOrLevelUnit, "records_per_second");
  assert.ok(
    Number.isFinite(records.statistics.average.value) && records.statistics.average.value > 0
  );
  assert.ok(
    records.sourceReferences.some((source: any) => source.contractVersion === "openedge-db.v3")
  );
  assert.equal(context.parameterReference?.state, "captured");
  const parameters = validateDatabaseParameterSnapshot(
    JSON.parse(
      fs.readFileSync(path.join(root, run.id, String(context.parameterReference.artifact)), "utf8")
    )
  );
  assert.equal(parameters.runId, run.id);
  assert.ok(parameters.capturedAt);
  return { context, summary };
}
