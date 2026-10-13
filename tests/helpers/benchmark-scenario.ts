/* Native acceptance runs one real production experiment at a time, with
   unchanged workloads, load generation, phase clocks and observer sources. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import { loadConfig } from "../../packages/contracts/src/config";
import { loadOpenEdgeImageEnvironment } from "../../packages/contracts/src/local-env";
import { DockerComposeOrchestrator } from "../../packages/compose-runner/src/orchestrator";
import { ComposeBundle } from "../../packages/compose-runner/src/run-compose";
import { Scenario } from "../../packages/contracts/src/scenario";
import { isTerminal } from "../../packages/contracts/src/run-state";
import { pathToFileURL } from "node:url";
import { renderBenchmarkDashboards } from "./benchmark-dashboard-render";

export async function runBenchmarkScenario(options: {
  evidenceRoot: string;
  seedRoot: string;
  scenario: Scenario;
}): Promise<any> {
  const active = execFileSync("docker", ["ps", "-q", "--filter", "label=parkbench.run_id"], {
    encoding: "utf8"
  }).trim();
  assert.equal(active, "", "native acceptance requires the platform experiment queue to be idle");
  const nativeImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
  const { hostMemoryCheck } = await nativeImport(
    pathToFileURL(path.resolve("scripts/host-preflight.mjs")).href
  );
  assert.equal(hostMemoryCheck(fs.readFileSync("/proc/meminfo", "utf8")).status, "pass");
  const directory = path.join(options.evidenceRoot, options.scenario.id);
  fs.mkdirSync(directory, { recursive: true });
  const previousLimit = process.env.PARKBENCH_DB_MEMORY_LIMIT;
  process.env.PARKBENCH_DB_MEMORY_LIMIT = "2g";
  const original = loadConfig();
  loadOpenEdgeImageEnvironment(
    process.cwd(),
    original.openedge.outputRoot ?? path.resolve(".parkbench/openedge")
  );
  const config = loadConfig(),
    copies: any[] = [];
  class AcceptanceOrchestrator extends DockerComposeOrchestrator {
    override async waitForReady(
      bundle: ComposeBundle,
      scenario: Scenario,
      timeout: number,
      cancelled?: () => boolean
    ) {
      await super.waitForReady(bundle, scenario, timeout, cancelled);
      const container = JSON.parse(
        execFileSync("docker", ["inspect", bundle.projectName + "-database-1"], {
          encoding: "utf8"
        })
      )[0];
      const seed = container.Mounts.find((m: any) => m.Destination === "/run/parkbench/seed/db");
      assert.equal(seed?.RW, false);
      const volume = container.Mounts.find((m: any) => m.Destination === "/psc/wrk");
      assert.ok(volume?.Name);
      assert.ok(container.HostConfig.Memory > 0 && container.HostConfig.Memory <= 2 * 1024 ** 3);
      copies.push({
        project: bundle.projectName,
        volume: volume.Name,
        seedReadOnly: true,
        memoryLimitBytes: container.HostConfig.Memory
      });
    }
  }
  let metricsTarget = "";
  const platform = createPlatform(
    {
      ...config,
      dbPath: ":memory:",
      artifactRoot: path.join(directory, "artifacts"),
      runRoot: path.join(directory, "compose"),
      discoveryRoots: { ...config.discoveryRoots!, seeds: path.dirname(options.seedRoot) },
      openedge: { ...config.openedge, defaultSeed: path.basename(options.seedRoot) }
    },
    {
      orchestrator: new AcceptanceOrchestrator(path.join(directory, "compose")),
      runCAdvisorTarget: () => metricsTarget,
      targetDiscoveryFileName: "benchmark-019-" + process.pid + "-" + Date.now() + ".json"
    }
  );
  const app = buildServer(platform);
  let experimentId: string | undefined;
  try {
    await platform.startupRecovery;
    const address = await app.listen({ host: "0.0.0.0", port: 0 });
    const hosts = Object.values(os.networkInterfaces() as Record<string, os.NetworkInterfaceInfo[]>)
      .flat()
      .filter((a) => a?.family === "IPv4" && !a.internal);
    const host =
      process.env.PARKBENCH_SMOKE_METRICS_HOST ??
      (hosts.length === 1 ? hosts[0]!.address : "host.docker.internal");
    metricsTarget = host + ":" + new URL(address).port;
    const created = platform.coordinator.createExperiment(
      {
        name: options.scenario.id,
        scenario: options.scenario,
        comparisonMode: "comparative",
        baselineVariantId: "baseline",
        repetitions: 1,
        variants: [{ id: "baseline", name: "Baseline", parameters: {} }],
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
    await platform.coordinator.startExperiment(created.id);
    const deadline = Date.now() + 20 * 60 * 1000;
    let previous = "";
    while (Date.now() < deadline) {
      const runs = platform.repositories.listRuns(created.id);
      const states = runs.map((r) => r.id + ":" + r.state).join(",");
      if (states !== previous) {
        console.log("benchmark_scenario_states:" + states);
        previous = states;
      }
      fs.writeFileSync(path.join(directory, "progress.json"), JSON.stringify(runs, null, 2));
      if (
        runs.length &&
        runs.every((r) => isTerminal(r.state) && r.cleanupStatus !== "PENDING") &&
        ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "INTERRUPTED"].includes(
          platform.repositories.getExperiment(created.id)!.status
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const [run] = platform.repositories.listRuns(created.id);
    assert.ok(run && isTerminal(run.state), "experiment acceptance timed out");
    assert.equal(run.cleanupStatus, "COMPLETE");
    const saved = platform.repositories.getSummaryCache(run.id);
    assert.equal(saved?.status, "READY");
    const summary = saved!.header!,
      loadgen = summary.workload as any;
    assert.equal(summary.windows.measurement.state, "completed");
    assert.ok(summary.windows.measurement.durationSeconds >= 119);
    assert.deepEqual(loadgen.phaseDurationsSeconds, options.scenario.phases);
    for (const phase of ["warmup", "measurement", "cooldown"])
      assert.ok(loadgen.phaseResults[phase].requests > 0, phase);
    assert.match(run.id, /-1-[a-z0-9]+$/);
    const boundaries = run.phaseBoundaries!;
    assert.equal(boundaries.warmup!.finishedAt, boundaries.measurement!.startedAt);
    assert.equal(boundaries.measurement!.finishedAt, boundaries.cooldown!.startedAt);
    const continuity: any[] = [];
    const cadence = config.prometheusScrapeIntervalSeconds ?? 5;
    for (const metric of [
      "parkbench_openedge_db_database_table_operations_total",
      "parkbench_openedge_db_index_blocks_read_total",
      "parkbench_openedge_db_index_blocks_written_total",
      "parkbench_openedge_db_buffer_pool_active_buffers",
      "parkbench_openedge_db_buffer_pool_free_buffers",
      "parkbench_openedge_pas_requests_total"
    ]) {
      const samples = await platform.prometheus.queryRawRange!(
        `${metric}{run_id=${JSON.stringify(run.id)}}`,
        Date.parse(boundaries.warmup!.startedAt!) / 1000,
        Date.parse(boundaries.cooldown!.finishedAt!) / 1000,
        cadence
      );
      fs.writeFileSync(path.join(directory, metric + ".json"), JSON.stringify(samples, null, 2));
      const identities = new Map<string, number[]>();
      for (const sample of samples) {
        assert.equal(sample.labels.phase, undefined);
        const key = JSON.stringify(sample.labels);
        const ts = identities.get(key) ?? [];
        ts.push(sample.timestamp);
        identities.set(key, ts);
      }
      assert.ok(identities.size > 0, metric + ": continuously collected source");
      for (const [identity, timestamps] of identities) {
        timestamps.sort((a, b) => a - b);
        const maximumGapSeconds = Math.max(...timestamps.slice(1).map((t, i) => t - timestamps[i]));
        assert.ok(maximumGapSeconds <= cadence * 1.5, metric + ": missing observations");
        for (const boundary of [
          boundaries.measurement!.startedAt!,
          boundaries.cooldown!.startedAt!
        ]) {
          const time = Date.parse(boundary) / 1000,
            before = timestamps.findLast((t) => t < time),
            after = timestamps.find((t) => t >= time);
          assert.ok(
            before !== undefined && after !== undefined && after - before <= cadence * 1.5,
            metric + ": phase boundary gap"
          );
        }
        continuity.push({
          metric,
          identity: JSON.parse(identity),
          sampleCount: timestamps.length,
          maximumGapSeconds
        });
      }
    }
    const ids = new Set(options.scenario.workload.operations.slice(0, 16).map((o) => o.id));
    const selectionGroups = {
      reads: { completed: 0, errors: 0 },
      writes: { completed: 0, errors: 0 }
    };
    for (const [id, values] of Object.entries(loadgen.operations) as [
      string,
      { completed: number; errors: number }
    ][]) {
      const group = ids.has(id) ? selectionGroups.reads : selectionGroups.writes;
      group.completed += values.completed;
      group.errors += values.errors;
    }
    const transactions: Record<string, unknown> = {};
    for (const suffix of ["commits_total", "rollbacks_total", "active_count"]) {
      const metric = "parkbench_openedge_db_transaction_" + suffix;
      transactions[metric] = await platform.prometheus.queryRawRange!(
        `${metric}{run_id=${JSON.stringify(run.id)}}`,
        Date.parse(boundaries.warmup!.startedAt!) / 1000,
        Date.parse(boundaries.cooldown!.finishedAt!) / 1000,
        cadence
      );
    }
    const resources = platform.repositories.listResources(run.id);
    assert.ok(resources.length && resources.every((r) => r.cleanupResult === "deleted"));
    const result = {
      ok: true,
      run,
      copies,
      summary,
      continuity,
      selectionGroups,
      transactions,
      resources,
      writeOutcomePolicy:
        "Actual write failures are retained; no successful-count ratio is required."
    };
    if (options.scenario.id === "parkbench-read-mix") {
      const rendered = await renderBenchmarkDashboards({
        runId: run.id,
        port: new URL(address).port,
        prometheusUrl: config.prometheusUrl,
        start: Date.parse(boundaries.warmup!.startedAt!),
        end: Date.parse(boundaries.cooldown!.finishedAt!),
        directory
      });
      fs.writeFileSync(
        path.resolve(".parkbench/validation/feature019/us4-grafana.json"),
        JSON.stringify(rendered, null, 2)
      );
    }
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (experimentId) {
      for (const run of platform.repositories.listRuns(experimentId))
        if (!isTerminal(run.state)) platform.coordinator.cancel(run.id);
      const until = Date.now() + 180000;
      while (
        Date.now() < until &&
        (platform.repositories
          .listRuns(experimentId)
          .some((run) => !isTerminal(run.state) || run.cleanupStatus === "PENDING") ||
          platform.repositories.getExperiment(experimentId)?.status === "RUNNING")
      )
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await app.close();
    if (previousLimit === undefined) delete process.env.PARKBENCH_DB_MEMORY_LIMIT;
    else process.env.PARKBENCH_DB_MEMORY_LIMIT = previousLimit;
  }
}
