import os from "node:os";
import { ObserverCollector } from "../../packages/observers/src/collector";
import { HttpMetricsObserver } from "../../packages/observers/src/http-observer";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  DIAGNOSTIC_DEFAULTS,
  freezeDiagnosticsConfig,
  validateMeasurementProducerConfig
} from "../../packages/contracts/src/measurement-diagnostics";
const enabled = process.env.PARKBENCH_RUN_OPENEDGE_TESTS === "1";
// Investigation-only fixture variants; these never configure benchmark runs.
const bindEvidence = process.env.PARKBENCH_NATIVE_DIAGNOSTICS_BIND_FIXTURE === "1";
const steadyEvidence = process.env.PARKBENCH_NATIVE_DIAGNOSTICS_STEADY_FIXTURE === "1";
const keepAliveEvidence = process.env.PARKBENCH_NATIVE_DIAGNOSTICS_KEEPALIVE_FIXTURE === "1";
function docker(args: string[]) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1024 ** 2
    }).trim();
  } catch {
    throw new Error("native_diagnostics_fixture_docker_operation_failed");
  }
}
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 90000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("native_diagnostics_fixture_wait_expired");
}
test(
  "licensed observer retains correlated native generations, independent inventory and quiescent bounded producer evidence",
  { skip: !enabled, timeout: 240000 },
  async () => {
    const dbImage = process.env.PARKBENCH_DATABASE_SETUP_TEST_IMAGE,
      observerImage = process.env.PARKBENCH_OPENEDGE_OBSERVER_IMAGE,
      nodeImage = process.env.PARKBENCH_OBSERVER_IMAGE;
    assert.ok(
      dbImage && observerImage && nodeImage,
      "explicit opt-in requires DB, native observer and generic observer image references"
    );
    const queue = await (
      await fetch(
        (process.env.PARKBENCH_CONTROL_UI_URL ?? "http://127.0.0.1:13002") + "/api/v1/queue"
      )
    ).json();
    assert.ok(
      !queue.activeExperiment && !queue.items?.length,
      "licensed fixture requires an otherwise idle queue"
    );
    const runId = "f024-native-" + randomUUID(),
      db = runId + "-db",
      observer = runId + "-observer",
      network = runId + "-net",
      data = runId + "-data",
      evidence = runId + "-evidence",
      root = path.resolve(".parkbench/validation/feature024/native", runId);
    const initialCwd = process.cwd();
    await fs.mkdir(root, { recursive: true });
    // Host-bind sharing can invalidate a mounted working-directory handle on
    // Docker Desktop. All fixture paths are absolute; keep its process on /tmp.
    if (bindEvidence) process.chdir(os.tmpdir());
    const evidenceRoot = path.join(root, "evidence");
    if (bindEvidence) await fs.mkdir(evidenceRoot, { recursive: true });
    const mountRoot = bindEvidence
      ? `type=bind,source=${evidenceRoot}`
      : `type=volume,source=${evidence}`;
    const labels = [
        "--label",
        "parkbench.managed=true",
        "--label",
        `parkbench.run_id=${runId}`,
        "--label",
        "org.parkbench.validation.feature=feature024"
      ],
      created = { containers: [] as string[], volumes: [] as string[], network: false };
    const node = (script: string) =>
      docker([
        "run",
        "--rm",
        ...labels,
        "--entrypoint",
        "node",
        "--mount",
        `${mountRoot},target=/evidence`,
        nodeImage!,
        "-e",
        script
      ]);
    let cleanup = "UNCERTAIN",
      summary: any,
      shutdown: any,
      scraperContainer: string | undefined;
    try {
      for (const image of [dbImage, observerImage, nodeImage])
        docker(["image", "inspect", "--format", "{{.Id}}", image!]);
      docker(["network", "create", ...labels, network]);
      created.network = true;
      for (const volume of bindEvidence ? [data] : [data, evidence]) {
        docker(["volume", "create", ...labels, volume]);
        created.volumes.push(volume);
      }
      docker([
        "run",
        "--rm",
        ...labels,
        "--user",
        "0",
        "--entrypoint",
        "sh",
        "-v",
        `${data}:/psc/wrk`,
        dbImage!,
        "-ec",
        'mkdir -p /psc/wrk/fixture; cd /psc/wrk/fixture; procopy "$DLC/prolang/utf/empty8" parkbench; chown -R pscadmin /psc/wrk'
      ]);
      docker([
        "run",
        "-d",
        "--name",
        db,
        ...labels,
        "--network",
        network,
        "--network-alias",
        "database",
        "--entrypoint",
        "sh",
        "-v",
        `${data}:/psc/wrk`,
        dbImage!,
        "-ec",
        "cd /psc/wrk/fixture; proserve parkbench -S 20931 -N tcp -n 100 -B 500; exec sleep infinity"
      ]);
      created.containers.push(db);
      const config = freezeDiagnosticsConfig(
        { contractVersion: "measurement-diagnostics-config.v1", mode: "trace" },
        DIAGNOSTIC_DEFAULTS,
        Date.now()
      );
      const producer = validateMeasurementProducerConfig(
        JSON.parse(
          node(
            `(async()=>{const fs=require('node:fs/promises');const {DiagnosticBudgetStore}=require('/app/dist/packages/observers/src/measurement-diagnostics-writer.js');const store=await DiagnosticBudgetStore.open('/evidence',${JSON.stringify(runId)},${JSON.stringify(config)});const p={contractVersion:'measurement-diagnostics-producer.v1',runId:${JSON.stringify(runId)},experimentId:'native-fixture',diagnosticAttemptId:'attempt-1',runBudgetId:(await store.read()).runBudgetId,component:'db-observer',config:${JSON.stringify(config)},summaryBytes:2097152,traceBytes:1048576,pendingLimitBytes:Math.floor(1048576/12)};process.stdout.write(JSON.stringify(p))})().catch(()=>process.exit(1))`
          )
        )
      );
      const env = {
        PARKBENCH_RUN_ID: runId,
        PARKBENCH_EXPERIMENT_ID: "native-fixture",
        PARKBENCH_VARIANT_ID: "fixture",
        PARKBENCH_REPETITION: "1",
        PARKBENCH_OBSERVER_KIND: "openedge_db_v1",
        PARKBENCH_METRICS_PORT: "9100",
        PARKBENCH_OBSERVER_READ_ONLY: "true",
        PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE: "parkbench-openedge-db-observer",
        DB_NAME: "parkbench",
        DB_HOST: "database",
        DB_BROKER_PORT: "20931",
        PARKBENCH_MEASUREMENT_DIAGNOSTICS: JSON.stringify(producer)
      };
      docker([
        "run",
        "-d",
        "--name",
        observer,
        ...labels,
        "--network",
        network,
        "-p",
        "127.0.0.1::9100",
        "--mount",
        bindEvidence
          ? `type=bind,source=${evidenceRoot}/${runId}/measurement-diagnostics,target=/run/parkbench/measurement-diagnostics`
          : `type=volume,source=${evidence},target=/run/parkbench/measurement-diagnostics,volume-subpath=${runId}/measurement-diagnostics`,
        ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        observerImage!
      ]);
      created.containers.push(observer);
      const address = "http://" + docker(["port", observer, "9100"]).split(/\r?\n/)[0];
      await until(async () => {
        try {
          const response = await fetch(address + "/health", { signal: AbortSignal.timeout(5000) });
          await response.text();
          return response.ok ? true : undefined;
        } catch {
          return undefined;
        }
      });
      const request = (ordinal: number) =>
        fetch(address + "/metrics", {
          headers: {
            "x-parkbench-diagnostic-caller": "controller",
            "x-parkbench-diagnostic-request-id": `fixture-controller:${ordinal}`
          },
          signal: AbortSignal.timeout(30000)
        });
      const responses = await Promise.all([request(1), request(2)]);
      for (const response of responses) assert.equal(response.status, 200);
      const identities = responses.map((response) =>
        response.headers.get("x-parkbench-collection-id")
      );
      assert.ok(identities[0]);
      assert.equal(
        identities[0],
        identities[1],
        "overlapping HTTP callers share one real native capture"
      );
      const metricBodies = await Promise.all(responses.map((response) => response.text()));
      assert.ok(
        metricBodies.every(
          (body) =>
            body.includes("parkbench_openedge_db_") && !body.includes("measurement-observation.v1")
        )
      );
      const fresh = await request(3);
      assert.equal(fresh.status, 200);
      assert.notEqual(
        fresh.headers.get("x-parkbench-collection-id"),
        identities[0],
        "a later request is a fresh generation even when measurements are unchanged"
      );
      await fresh.text();
      const inventoryResponse = await fetch(address + "/latch-inventory", {
        signal: AbortSignal.timeout(30000)
      });
      assert.equal(inventoryResponse.status, 200);
      const inventory: any = await inventoryResponse.json();
      assert.equal(inventory.protocolVersion, 4);
      assert.equal(inventory.measurementInventory.runId, runId);
      assert.ok(inventory.measurementInventory.availability.length > 0);
      assert.ok(inventory.measurementInventory.dimensions.latch_id.length > 0);
      assert.ok(!Object.hasOwn(inventory.measurementInventory, "metrics"));
      const events: any[] = [];
      const context = {
        runId,
        experimentId: "native-fixture",
        variantId: "fixture",
        repetition: 1,
        phase: "measurement",
        measurementEvidence: {
          diagnosticAttemptId: "attempt-1",
          record: (event: any) => {
            events.push(event);
            return `fixture-controller:${events.length}`;
          }
        }
      };
      const collector = new ObserverCollector(
        [
          {
            id: "openedge-db",
            kind: "openedge_db_v1",
            required: true,
            samplingIntervalSeconds: 5,
            configuration: { metricsUrl: address, authoritativePublisher: "endpoint" }
          }
        ],
        context,
        { create: () => new HttpMetricsObserver("openedge-db", "openedge_db_v1", address) }
      );
      const result = await collector.collectPhase(context, 0, 0);
      assert.equal(result[0].observed, 1);
      assert.equal(
        events.filter((event) => event.stage === "DIAGNOSTIC_WRITE" && event.outcome === "REJECTED")
          .length,
        0,
        "native default metric families must fit the bounded diagnostic inventory"
      );
      if (steadyEvidence)
        for (let ordinal = 10; ordinal < 80; ordinal++) {
          const response = await request(ordinal);
          assert.equal(response.status, 200);
          await response.text();
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      // An independent container keeps scraping during synchronous docker stop
      // waits. Pausing this client would miss the production keep-alive failure.
      let finishingRequest: ReturnType<typeof request> | undefined;
      const scraper = { attempted: 0, completed: 0, errors: 0 };
      if (keepAliveEvidence) {
        scraperContainer = runId + "-scraper";
        const script = `const http=require('node:http'),agent=new http.Agent({keepAlive:true,maxSockets:1});
          let attempted=0,completed=0,errors=0;
          const poll=()=>{attempted++;console.log(JSON.stringify({kind:'started',attempted,completed,errors}));
            http.get(${JSON.stringify("http://" + observer + ":9100/metrics")},{agent},res=>{res.resume();res.once('end',()=>{completed++;console.log(JSON.stringify({kind:'complete',attempted,completed,errors}));setTimeout(poll,100)});res.once('error',()=>{errors++;console.log(JSON.stringify({kind:'error',attempted,completed,errors}));agent.destroy()})}).once('error',()=>{errors++;console.log(JSON.stringify({kind:'error',attempted,completed,errors}));agent.destroy()});};poll();`;
        docker([
          "run",
          "-d",
          "--name",
          scraperContainer,
          ...labels,
          "--network",
          network,
          "--entrypoint",
          "node",
          nodeImage!,
          "-e",
          script
        ]);
        created.containers.push(scraperContainer);
        await until(async () =>
          docker(["logs", "--tail", "1", scraperContainer!]).includes('"started"')
            ? true
            : undefined
        );
      } else finishingRequest = request(4);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stopStarted = performance.now();
      docker(["stop", "--time", "10", observer]);
      const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", observer]));
      if (scraperContainer) {
        for (const line of docker(["logs", "--tail", "32", scraperContainer])
          .split(/\r?\n/)
          .filter(Boolean)) {
          const record = JSON.parse(line);
          scraper.attempted = record.attempted;
          scraper.completed = record.completed;
          scraper.errors = record.errors;
        }
      }
      shutdown = {
        exitCode: state.ExitCode,
        oomKilled: state.OOMKilled,
        finishedAt: state.FinishedAt,
        durationMs: performance.now() - stopStarted,
        scraper
      };
      assert.equal(
        shutdown.exitCode,
        0,
        "a persistent scraper must not force-kill the owned observer"
      );
      if (finishingRequest) {
        const response = await finishingRequest;
        assert.equal(response.status, 200);
        await response.text();
      }
      if (keepAliveEvidence)
        assert.ok(
          scraper.completed >= 1,
          "the active source response must finish in full before sealing"
        );
      summary = JSON.parse(
        node(
          `(async()=>{const fs=require('node:fs/promises');const path=require('node:path');const {DiagnosticBudgetStore}=require('/app/dist/packages/observers/src/measurement-diagnostics-writer.js');const {inspectProducerFile}=require('/app/dist/apps/control-plane/src/measurement-diagnostics/producer-files.js');const directory='/evidence/'+${JSON.stringify(runId)}+'/measurement-diagnostics';const store=await DiagnosticBudgetStore.attach(directory,${JSON.stringify(runId)},${JSON.stringify(producer.runBudgetId)},${JSON.stringify(config)});const files=await fs.readdir(directory+'/attempt-1/summary');if(files.length!==1)throw Error('producer_count');const instanceId=files[0].slice('db-observer-'.length,-'.jsonl'.length),owner={runId:${JSON.stringify(runId)},attemptId:'attempt-1',component:'db-observer',instanceId};const result=await inspectProducerFile(path.join(directory,'attempt-1/summary',files[0]),owner,'summary',2097152);const trace=await inspectProducerFile(path.join(directory,'attempt-1/trace',files[0]),owner,'trace',1048576);const budget=await store.read();process.stdout.write(JSON.stringify({producer:result.terminal,traceBytes:trace.bytes,budgetAccountingState:budget.accountingState,outstandingProducerReservations:budget.reservations.filter(r=>r.reservationId!=='retention-control').length}))})().catch(()=>process.exit(1))`
        )
      );
      assert.equal(summary.producer.recordingState, "SEALED");
      assert.equal(summary.producer.flushState, "COMPLETE");
      assert.equal(summary.producer.droppedEvents, 0);
      assert.equal(summary.producer.droppedMetadataRecords, 0);
      assert.equal(summary.producer.traceBytes, summary.traceBytes);
      assert.equal(summary.budgetAccountingState, "CONFIRMED");
      assert.equal(summary.outstandingProducerReservations, 0);
    } finally {
      let failed = false;
      for (const container of created.containers.reverse())
        try {
          const owner = docker([
            "inspect",
            "--format",
            '{{index .Config.Labels "parkbench.run_id"}}',
            container
          ]);
          assert.equal(owner, runId);
          docker(["rm", "-f", container]);
        } catch {
          failed = true;
        }
      if (created.network)
        try {
          docker(["network", "rm", network]);
        } catch {
          failed = true;
        }
      for (const volume of created.volumes)
        try {
          const owner = docker([
            "volume",
            "inspect",
            "--format",
            '{{index .Labels "parkbench.run_id"}}',
            volume
          ]);
          assert.equal(owner, runId);
          docker(["volume", "rm", volume]);
        } catch {
          failed = true;
        }
      cleanup = failed ? "UNCERTAIN" : "COMPLETE";
      await fs.writeFile(
        path.join(root, "result.json"),
        JSON.stringify(
          {
            contractVersion: "measurement-native-fixture-result.v1",
            runId,
            origin: "FIXTURE",
            completedAtMs: Date.now(),
            nativeProtocolVersion: summary ? 4 : null,
            evidenceStorage: bindEvidence ? "HOST_BIND" : "DOCKER_VOLUME",
            steadyEvidence,
            keepAliveEvidence,
            shutdown: shutdown ?? null,
            producer: summary?.producer ?? null,
            budgetAccountingState: summary?.budgetAccountingState ?? "UNAVAILABLE",
            cleanup
          },
          null,
          2
        ) + "\n"
      );
      if (bindEvidence) process.chdir(initialCwd);
      assert.equal(cleanup, "COMPLETE");
    }
  }
);
