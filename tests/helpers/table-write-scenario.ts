/* Test-only lifecycle inspection around the real production orchestrator. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DockerComposeOrchestrator } from "../../packages/compose-runner/src/orchestrator";
import { ComposeBundle } from "../../packages/compose-runner/src/run-compose";
import { RunResource } from "../../packages/compose-runner/src/resources";
import { Scenario } from "../../packages/contracts/src/scenario";
import { isTerminal } from "../../packages/contracts/src/run-state";
import os from "node:os";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import { loadConfig } from "../../packages/contracts/src/config";
import { loadOpenEdgeImageEnvironment } from "../../packages/contracts/src/local-env";
import {
  validateRunContext,
  validateSummaryHeader
} from "../../packages/contracts/src/run-summary";

const boundedFileHash = (filename: string): string => {
  const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filename, "r");
  try {
    let bytes: number;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
};
export const databaseHashes = (root: string): Record<string, string> =>
  Object.fromEntries(
    fs
      .readdirSync(root)
      .filter((n) => /\.(?:db|st|[bdat]\d+)$/.test(n))
      .sort()
      .map((n) => [
        n,
        boundedFileHash(path.join(root, n))
      ])
  );

export class TableWriteScenarioOrchestrator extends DockerComposeOrchestrator {
  readonly copies: any[] = [];
  readonly writes: any[] = [];
  readonly seedHashes: Record<string, string>;
  constructor(
    readonly evidenceRoot: string,
    readonly seedRoot: string,
    readonly expected: any,
    readonly inventory: any,
    readonly assertions: any
  ) {
    super(path.join(evidenceRoot, "compose"));
    this.seedHashes = databaseHashes(seedRoot);
  }

  private snapshot(bundle: ComposeBundle, stage: string): any {
    const container = bundle.projectName + "-database-1";
    const directory = "/psc/wrk/table-write-verification";
    const execute = (args: string[]) => {
      try {
        return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        throw new Error(
          "write_scenario_snapshot_failed:" +
            [failure.stdout, failure.stderr, failure.message]
              .filter(Boolean)
              .join("\n")
              .slice(-4000)
        );
      }
    };
    execute(["exec", "--user", "root", container, "mkdir", "-p", directory]);
    execute(["exec", "--user", "root", container, "chmod", "777", directory]);
    execute([
      "cp",
      path.resolve("tests/fixtures/table-write-workloads/abl/verify.p"),
      container + ":" + directory + "/verify.p"
    ]);
    const report = directory + "/snapshot.json";
    execute([
      "exec",
      "--user",
      "pscadmin",
      "-e",
      "PARKBENCH_WRITE_FIXTURE=1",
      "-e",
      "PROPATH=/psc/dlc/tty,/psc/dlc/tty/OpenEdge.Core.apl",
      container,
      "/psc/dlc/bin/pro",
      "-T",
      "/psc/wrk",
      "-db",
      "/psc/wrk/parkbench",
      "-H",
      "127.0.0.1",
      "-S",
      "20931",
      "-b",
      "-p",
      directory + "/verify.p",
      "-param",
      JSON.stringify({
        tables: this.inventory.tables.map((t: any) => t.name),
        requireKnown: true,
        report
      })
    ]);
    const destination = path.join(this.evidenceRoot, bundle.projectName + "-" + stage + ".json");
    execute(["cp", container + ":" + report, destination]);
    return JSON.parse(fs.readFileSync(destination, "utf8"));
  }

  override async waitForReady(
    bundle: ComposeBundle,
    scenario: Scenario,
    timeoutMs: number,
    cancelled?: () => boolean
  ): Promise<void> {
    await super.waitForReady(bundle, scenario, timeoutMs, cancelled);
    const before = this.snapshot(bundle, "before");
    assert.deepEqual(before, this.expected, "run starts from fresh prepared source copy");
    const container = JSON.parse(
      execFileSync("docker", ["inspect", bundle.projectName + "-database-1"], { encoding: "utf8" })
    )[0];
    const seed = container.Mounts.find((m: any) => m.Destination === "/run/parkbench/seed/db");
    assert.equal(seed.RW, false);
    const volume = container.Mounts.find((m: any) => m.Destination === "/psc/wrk");
    assert.ok(volume?.Name);
    assert.ok(
      this.copies.every((copy) => copy.volume !== volume.Name),
      "independent run-owned writable volume"
    );
    this.copies.push({
      project: bundle.projectName,
      volume: volume.Name,
      seedReadOnly: true,
      freshCopy: true
    });
  }

  override async cleanup(bundle: ComposeBundle, resources: RunResource[]): Promise<RunResource[]> {
    let inspectionError: unknown;
    try {
      const after = this.snapshot(bundle, "before-cleanup");
      const selected = new Map<string, Set<string>>();
      const creates = new Set<string>();
      const createLobs = new Map<string, string[]>();
      for (const operation of bundle.scenario.workload.operations) {
        const body: any = operation.bodyTemplate;
        const input: any = body.input;
        const table = this.inventory.tables.find((t: any) => t.procedure === body.procName);
        if (input.Operation === "create") {
          creates.add(table.name);
          createLobs.set(table.name, input.LobFields);
        } else {
          const allowed = selected.get(table.name) ?? new Set<string>();
          [...input.FieldsList, ...input.LobFields].forEach((f: string) => allowed.add(f));
          selected.set(table.name, allowed);
        }
      }
      const persisted: any[] = [];
      for (const table of this.inventory.tables) {
        const before = this.expected[table.name];
        const current = after[table.name];
        this.assertions.assertSnapshot(current, table);
        const original = new Map(before.rows.map((r: any) => [String(r[table.primaryField]), r]));
        const added = current.rows.filter((r: any) => !original.has(String(r[table.primaryField])));
        assert.equal(
          current.rows.filter((r: any) => original.has(String(r[table.primaryField]))).length,
          before.count,
          table.name + ":no deleted identities"
        );
        if (creates.has(table.name)) assert.ok(added.length > 0, table.name + ":persisted creates");
        else {
          assert.equal(added.length, 0, table.name + ":no creates");
          assert.equal(current.sequence, before.sequence, table.name + ":no sequence allocation");
        }
        for (const row of added)
          for (const field of table.fields.filter((f: any) => f.lob)) {
            if (createLobs.get(table.name)?.includes(field.name))
              assert.equal(row[field.name].bytes, field.lob.defaultBytes);
            else assert.equal(row[field.name], null, table.name + ":omitted create LOB");
          }
        assert.ok(current.count >= before.count);
        const allowed = selected.get(table.name) ?? new Set<string>();
        const changes: string[] = [];
        for (const row of current.rows) {
          const prior: any = original.get(String(row[table.primaryField]));
          if (!prior) continue;
          assert.equal(row.$rowid, prior.$rowid);
          for (const field of table.fields) {
            if (!allowed.has(field.name))
              assert.deepEqual(
                row[field.name],
                prior[field.name],
                table.name + ":unselected:" + field.name
              );
            else if (JSON.stringify(row[field.name]) !== JSON.stringify(prior[field.name]))
              changes.push(field.name);
          }
        }
        if (allowed.size) assert.ok(changes.length > 0, table.name + ":persisted selected update");
        persisted.push({
          table: table.name,
          added: added.length,
          changedSelectedFields: [...new Set(changes)]
        });
      }
      this.assertions.assertRelationships(after, this.inventory);
      assert.deepEqual(databaseHashes(this.seedRoot), this.seedHashes);
      this.writes.push({
        project: bundle.projectName,
        ok: true,
        capturedBeforeCleanup: true,
        persisted
      });
    } catch (error) {
      inspectionError = error;
      this.writes.push({ project: bundle.projectName, ok: false, error: String(error) });
    }
    // Always preserve normal production cleanup, including failed inspection.
    const cleaned = await super.cleanup(bundle, resources);
    assert.deepEqual(databaseHashes(this.seedRoot), this.seedHashes);
    if (inspectionError) throw inspectionError;
    return cleaned;
  }
}

export async function runMeasuredScenario(options: {
  evidenceRoot: string;
  seedRoot: string;
  expected: any;
  inventory: any;
  assertions: any;
  scenario: Scenario;
}): Promise<any> {
  const executionFiles = [
    "tests/helpers/table-write-scenario.ts",
    "scripts/openedge/test-write-workloads.mjs",
    "tests/fixtures/table-write-workloads/scenario-suite.mjs",
    "packages/contracts/src/openedge-validation.ts",
    "packages/metrics/src/measurement-statistics.ts",
    "packages/metrics/src/measurement-summary.ts",
    "packages/metrics/src/resource-membership.ts",
    "packages/metrics/src/completeness.ts",
    "apps/control-plane/src/runs/comparison-summary-service.ts",
    "apps/control-plane/src/runs/coordinator.ts",
    "apps/control-plane/src/runs/phase-runner.ts",
    "apps/loadgen/src/runner.ts",
    "packages/observers/src/collector.ts",
    "packages/metrics/src/discovery.ts",
    "packages/metrics/src/prometheus-client.ts",
    "packages/metrics/src/required-sources.ts",
    "packages/metrics/src/run-metrics.ts",
    "apps/control-plane/src/grafana/continuous-phases.ts",
    "apps/control-plane/src/grafana/run-timeline.ts",
    "apps/control-plane/src/grafana/prom-api.ts",
    "apps/control-plane/src/grafana/table-ranking.ts",
    "apps/control-plane/src/platform.ts",
    "packages/compose-runner/src/orchestrator.ts"
  ];
  const executionHashes = () =>
    Object.fromEntries(
      executionFiles.map((file) => [
        file,
        crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
      ])
    );
  const sourceHashes = executionHashes();
  const original = loadConfig();
  loadOpenEdgeImageEnvironment(
    process.cwd(),
    original.openedge.outputRoot ?? path.resolve(".parkbench/openedge")
  );
  const config = loadConfig();
  const orchestrator = new TableWriteScenarioOrchestrator(
    options.evidenceRoot,
    options.seedRoot,
    options.expected,
    options.inventory,
    options.assertions
  );
  let metricsTarget = "";
  const platform = createPlatform(
    {
      ...config,
      dbPath: ":memory:",
      artifactRoot: path.join(options.evidenceRoot, "artifacts"),
      runRoot: path.join(options.evidenceRoot, "compose"),
      discoveryRoots: { ...config.discoveryRoots!, seeds: path.dirname(options.seedRoot) },
      openedge: { ...config.openedge, defaultSeed: path.basename(options.seedRoot) }
    },
    {
      orchestrator,
      runCAdvisorTarget: () => metricsTarget,
      targetDiscoveryFileName: "table-write-scenario-" + process.pid + "-" + Date.now() + ".json"
    }
  );
  const app = buildServer(platform);
  let experimentId: string | undefined;
  try {
    await platform.startupRecovery;
    const address = await app.listen({ host: "0.0.0.0", port: 0 });
    const addresses = Object.values(
      os.networkInterfaces() as Record<
        string,
        Array<{ family: string; internal: boolean; address: string }>
      >
    )
      .flat()
      .filter((a) => a?.family === "IPv4" && !a.internal);
    const host =
      process.env.PARKBENCH_SMOKE_METRICS_HOST ??
      (addresses.length === 1 ? addresses[0]!.address : "host.docker.internal");
    metricsTarget = host + ":" + new URL(address).port;
    const created = platform.coordinator.createExperiment(
      {
        scenario: options.scenario,
        comparisonMode: "comparative",
        baselineVariantId: "baseline",
        repetitions: 1,
        variants: [
          { id: "baseline", name: "Baseline", parameters: {} },
          { id: "independent", name: "Independent fresh copy", parameters: {} }
        ],
        inputs: {
          databaseImage: config.openedge.dbImage!,
          pasImage: config.openedge.pasImage!,
          seed: options.seedRoot,
          seedName: path.basename(options.seedRoot),
          databaseName: "parkbench",
          applicationArchive: config.openedge.appArchive!,
          credentialRef: config.openedge.credentialRef
        }
      } as any,
      options.scenario
    );
    experimentId = created.id;
    platform.coordinator.startExperiment(created.id);
    const deadline = Date.now() + 25 * 60 * 1000;
    let previous = "";
    while (Date.now() < deadline) {
      const experiment = platform.repositories.getExperiment(created.id)!;
      const runs = platform.repositories.listRuns(created.id);
      const states = runs.map((r) => r.id + ":" + r.state).join(",");
      if (states !== previous) {
        console.log("banking_write_states:" + states);
        previous = states;
      }
      fs.writeFileSync(
        path.join(options.evidenceRoot, "measured-progress.json"),
        JSON.stringify(
          { experiment, runs, copies: orchestrator.copies, writes: orchestrator.writes },
          null,
          2
        )
      );
      if (
        ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "INTERRUPTED"].includes(experiment.status)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const runs = platform.repositories.listRuns(created.id);
    assert.equal(runs.length, 2);
    const evidence = await Promise.all(
      runs.map(async (run) => {
        assert.equal(run.state, "SUCCEEDED", run.id + ":" + run.failureReason);
        assert.equal(run.cleanupStatus, "COMPLETE");
        const cache = platform.repositories.getSummaryCache(run.id);
        assert.equal(cache?.status, "READY");
        const summary = cache!.header!;
        validateSummaryHeader(summary, run.id);
        const context = JSON.parse(
          platform.storage.read(summary.contextReference.path).toString("utf8")
        );
        validateRunContext(context, run.id);
        const workload: any = summary.workload;
        assert.ok(workload.requests.completed > 0);
        assert.equal(workload.requests.errors, 0);
        assert.equal(workload.timeoutCount, 0);
        assert.equal(summary.quality.complete, true);
        assert.equal(summary.windows.measurement.state, "completed");
        assert.ok(summary.windows.measurement.durationSeconds >= options.scenario.phases.measurementSeconds - 1);
        assert.ok(summary.totalRowCount > 0);
        assert.equal(context.parameterReference?.state, "captured");
        // Normal cleanup removes the transient raw file. The published summary
        // retains the complete load-generator result, including all phase counts.
        const loadgen = summary.workload as any;
        assert.equal(loadgen.contractVersion, "loadgen.v1");
        assert.deepEqual(loadgen.phaseDurationsSeconds, options.scenario.phases);
        for (const phase of ["warmup", "measurement", "cooldown"]) {
          assert.ok(loadgen.phaseResults[phase].requests > 0);
          assert.equal(loadgen.phaseResults[phase].failures, 0);
          assert.equal(loadgen.phaseResults[phase].timeoutCount, 0);
        }
        for (const operation of options.scenario.workload.operations)
          assert.ok(
            loadgen.operations[operation.id]?.completed > 0,
            operation.id + ":measured requests"
          );
        const resources = platform.repositories.listResources(run.id);
        assert.ok(resources.length);
        assert.ok(
          resources.every(
            (r) => r.labels?.["parkbench.run_id"] === run.id && r.cleanupResult === "deleted"
          )
        );
        const boundaries = run.phaseBoundaries!;
        assert.equal(boundaries.warmup!.finishedAt, boundaries.measurement!.startedAt);
        assert.equal(boundaries.measurement!.finishedAt, boundaries.cooldown!.startedAt);
        const cadence = config.prometheusScrapeIntervalSeconds ?? 5;
        const continuity = [];
        for (const metric of [
          "node_memory_MemAvailable_bytes",
          "parkbench_openedge_db_database_table_operations_total",
          "parkbench_openedge_pas_requests_total"
        ]) {
          const samples = await platform.prometheus.queryRawRange!(
            `${metric}{run_id=${JSON.stringify(run.id)}}`,
            Date.parse(boundaries.warmup!.startedAt!) / 1000,
            Date.parse(boundaries.cooldown!.finishedAt!) / 1000,
            cadence
          );
          const series = new Map<string, number[]>();
          for (const sample of samples) {
            assert.equal(sample.labels.phase, undefined, metric + ": stable phase-free series");
            const key = JSON.stringify(sample.labels);
            const timestamps = series.get(key) ?? [];
            timestamps.push(sample.timestamp);
            series.set(key, timestamps);
          }
          assert.ok(series.size > 0, metric + ": source collected");
          for (const [labels, timestamps] of series) {
            timestamps.sort((a, b) => a - b);
            const transitions = [
              boundaries.measurement!.startedAt!,
              boundaries.cooldown!.startedAt!
            ].map((boundary) => {
              const time = Date.parse(boundary) / 1000;
              const before = timestamps.findLast((t) => t < time);
              const after = timestamps.find((t) => t >= time);
              assert.ok(
                before !== undefined && after !== undefined,
                metric + ": observed on both sides of phase boundary"
              );
              const gapSeconds = after! - before!;
              assert.ok(
                gapSeconds <= cadence * 1.5,
                metric + ": boundary exceeds normal sampling cadence: " + gapSeconds
              );
              return { boundary, before, after, gapSeconds };
            });
            continuity.push({
              metric,
              labels: JSON.parse(labels),
              sampleCount: timestamps.length,
              configuredCadenceSeconds: cadence,
              maximumGapSeconds: Math.max(...timestamps.slice(1).map((t, i) => t - timestamps[i])),
              transitions
            });
          }
        }
        fs.writeFileSync(
          path.join(options.evidenceRoot, run.id + "-phase-continuity.json"),
          JSON.stringify({ boundaries, continuity }, null, 2)
        );
        return { run, summary, context, loadgen, resources, continuity };
      })
    );
    assert.equal(orchestrator.copies.length, 2);
    assert.equal(orchestrator.writes.length, 2);
    assert.ok(orchestrator.writes.every((w) => w.ok));
    assert.deepEqual(
      executionHashes(),
      sourceHashes,
      "measurement executes unchanged orchestration and observer-summary sources"
    );
    return {
      ok: true,
      experimentId: created.id,
      runs: evidence,
      copies: orchestrator.copies,
      writes: orchestrator.writes,
      preparedSeedHashes: orchestrator.seedHashes,
      executionHashes: sourceHashes
    };
  } finally {
    if (experimentId) {
      for (const run of platform.repositories.listRuns(experimentId))
        if (!isTerminal(run.state)) platform.coordinator.cancel(run.id);
      const cleanupDeadline = Date.now() + 180000;
      while (
        Date.now() < cleanupDeadline &&
        platform.repositories.listRuns(experimentId).some((run) => !isTerminal(run.state))
      )
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await app.close();
  }
}
