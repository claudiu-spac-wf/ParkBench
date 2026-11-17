import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "@playwright/test";
import { HttpExperimentMetricAdmin } from "../../packages/metrics/src/prometheus-admin";
import { prometheusStorageBounds } from "../../apps/control-plane/src/experiments/actions/prometheus-storage-bounds";
import { scenarioSourceId } from "../../apps/control-plane/src/catalog/scenario-source";
const execute = promisify(execFile),
  pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "owned native individual and whole 2x2 rerun/removal preserve identity, sibling data and comparisons",
  {
    skip:
      process.env.PARKBENCH_RUN_EXPERIMENT_ACTION_TESTS !== "1" ||
      process.env.PARKBENCH_RUN_OPENEDGE_TESTS !== "1",
    timeout: 90 * 60000
  },
  async () => {
    const origin = process.env.PARKBENCH_CONTROL_API_URL ?? "http://127.0.0.1:13000";
    assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
    const resumePath = process.env.PARKBENCH_ACTION_RESUME_EVIDENCE;
    if (resumePath)
      assert.match(path.basename(resumePath), /^native-end-to-end-[a-f0-9-]{36}\.json$/);
    const resumed = resumePath ? JSON.parse(fs.readFileSync(resumePath, "utf8")) : undefined;
    const nonce = resumePath ? path.basename(resumePath).slice(18, -5) : crypto.randomUUID(),
      name = `feature026-actions-${nonce}.json`,
      source = path.resolve("examples/scenarios", name),
      root = path.resolve(".parkbench/validation/feature026"),
      evidence: any = resumed ?? { startedAt: new Date().toISOString(), status: "RUNNING" };
    let sourceOwned = false;
    if (resumed) {
      assert.ok(
        !evidence.rerunActionId && !evidence.removeActionId && !evidence.individualActionId,
        "resume only the completed initial matrix"
      );
      assert.match(evidence.experimentId, /^f026-actions-/);
      fs.copyFileSync(resumePath!, resumePath! + ".failed-baseline-attempt-" + Date.now());
      evidence.previousHarnessError = evidence.error;
      delete evidence.error;
      evidence.status = "RUNNING";
    }
    const save = () => {
      fs.mkdirSync(path.join(root, "rerun"), { recursive: true });
      fs.writeFileSync(
        path.join(root, `rerun/native-end-to-end-${nonce}.json`),
        JSON.stringify(evidence, null, 2)
      );
    };
    async function request(
      method: string,
      route: string,
      body?: unknown,
      key = crypto.randomUUID(),
      status?: number
    ) {
      const response = await fetch(origin + "/api/v1" + route, {
        method,
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120000)
      });
      const result = await response.json();
      assert.equal(
        response.status,
        status ?? (method === "GET" ? 200 : 202),
        `${route}: ${JSON.stringify(result).slice(0, 400)}`
      );
      return result as any;
    }
    async function idle() {
      const end = Date.now() + 120000;
      for (;;) {
        const queue = await request("GET", "/queue");
        assert.equal(queue.items.length, 0, "unrelated queued work must not be started");
        if (!queue.activeExperiment) return;
        assert.equal(queue.activeExperiment, evidence.experimentId, "unrelated active work");
        assert.ok(Date.now() < end, "host claim did not settle");
        await pause(1000);
      }
    }
    async function restartController() {
      await execute("scripts/compose.sh", ["restart", "control-plane"], { timeout: 60000 });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(origin + "/api/v1/queue", {
            signal: AbortSignal.timeout(3000)
          });
          if (response.ok) return;
        } catch {}
        await pause(250);
      }
      throw Error("controller_restart_readiness_timeout");
    }
    const identity = (runs: any[]) =>
      runs.map((r) => ({
        id: r.id,
        name: r.name,
        displayName: r.environmentSnapshot.runName,
        variantId: r.variantId,
        repetition: r.repetition,
        parameters: r.environmentSnapshot.effectiveConfiguration,
        scenario: r.environmentSnapshot.scenario,
        inputs: r.environmentSnapshot.inputs,
        iops: r.environmentSnapshot.databaseIops
      }));
    async function runs() {
      return Promise.all(evidence.runIds.map((id: string) => request("GET", "/runs/" + id)));
    }
    async function finish() {
      const end = Date.now() + 45 * 60000;
      for (;;) {
        const current = await runs();
        if (
          current.every(
            (r) =>
              ["SUCCEEDED", "THRESHOLD_FAILED", "CANCELLED", "FAILED"].includes(r.state) &&
              r.cleanupStatus === "COMPLETE"
          )
        )
          return current;
        assert.ok(Date.now() < end, "native action execution deadline");
        await pause(3000);
      }
    }
    async function action(kind: "RERUN" | "REMOVE", runId?: string) {
      const admittedAt = performance.now();
      const route = runId
        ? `/runs/${runId}/actions`
        : `/experiments/${evidence.experimentId}/actions`;
      const eligibility = await request("GET", route),
        body = {
          contractVersion: "experiment-action.v1",
          kind,
          confirm: true,
          expectedRevision: eligibility.executionRevision
        },
        key = crypto.randomUUID(),
        accepted = await request("POST", route, body, key),
        end = Date.now() + 15 * 60000;
      const label = runId ? "individual" : kind.toLowerCase();
      evidence[label + "ActionId"] = accepted.id;
      evidence[label + "AdmissionMs"] = performance.now() - admittedAt;
      const stages: string[] = [];
      evidence[label + "Stages"] = stages;
      save();
      for (;;) {
        const current = await request("GET", "/experiment-actions/" + accepted.id);
        if (stages.at(-1) !== current.stage) {
          stages.push(current.stage);
          save();
        }
        if (current.status !== "PENDING") {
          assert.equal(current.status, "SUCCEEDED", JSON.stringify(current));
          assert.equal(current.experimentId, undefined);
          assert.equal((await request("POST", route, body, key)).id, accepted.id);
          return;
        }
        assert.ok(Date.now() < end, "native action cleanup deadline");
        await pause(1000);
      }
    }
    function siblingInventory(ids: string[]) {
      const db = new DatabaseSync(path.resolve(".parkbench/parkbench.sqlite"), { readOnly: true });
      const result: any = {};
      try {
        for (const id of ids) {
          const records: any = {};
          for (const [table, key] of [
            ["runs", "id"],
            ["run_execution", "run_id"],
            ["control_run_metadata", "run_id"],
            ["artifacts", "run_id"],
            ["lifecycle_events", "run_id"],
            ["resources", "run_id"],
            ["environments", "run_id"],
            ["run_comparison_summaries", "run_id"],
            ["run_comparison_summary_rows", "run_id"]
          ])
            records[table] = db
              .prepare(`SELECT * FROM ${table} WHERE ${key}=? ORDER BY rowid`)
              .all(id);
          const files: any = {};
          for (const owner of ["artifacts", "runs"]) {
            const base = path.resolve(".parkbench", owner, id);
            const scan = (dir: string) => {
              if (!fs.existsSync(dir)) return;
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const file = path.join(dir, entry.name);
                assert.equal(entry.isSymbolicLink(), false);
                if (entry.isDirectory()) scan(file);
                else
                  files[owner + "/" + path.relative(base, file)] = crypto
                    .createHash("sha256")
                    .update(fs.readFileSync(file))
                    .digest("hex");
              }
            };
            scan(base);
          }
          const project = records.runs[0].compose_project;
          const scanOwned = (file: string) => {
            if (!fs.existsSync(file)) return;
            const stat = fs.lstatSync(file);
            assert.equal(stat.isSymbolicLink(), false);
            if (stat.isDirectory())
              for (const name of fs.readdirSync(file)) scanOwned(path.join(file, name));
            else
              files[path.relative(path.resolve(".parkbench"), file)] = crypto
                .createHash("sha256")
                .update(fs.readFileSync(file))
                .digest("hex");
          };
          for (const suffix of [
            ".yml",
            "-scenario.json",
            "-broker.argv",
            "-broker-directories",
            "-database-evidence"
          ])
            scanOwned(path.resolve(".parkbench/runs", project + suffix));
          result[id] = {
            recordsHash: crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex"),
            files
          };
        }
        return result;
      } finally {
        db.close();
      }
    }
    async function prometheusSourceCounts(ids: string[]) {
      const { stdout } = await execute("docker", [
        "ps",
        "-q",
        "--filter",
        "label=com.docker.compose.project=parkbench-platform",
        "--filter",
        "label=com.docker.compose.service=prometheus"
      ]);
      assert.equal(stdout.trim().split("\n").length, 1);
      const [prom] = JSON.parse((await execute("docker", ["inspect", stdout.trim()])).stdout);
      const port = prom.NetworkSettings.Ports["9090/tcp"].find(
        (p: any) => p.HostIp === "127.0.0.1"
      );
      assert.ok(port);
      const result: any = {};
      for (const id of ids) {
        result[id] = {};
        for (const label of ["run_id", "container_label_parkbench_run_id"]) {
          const query = `sum(count_over_time({${label}=${JSON.stringify(id)}}[1d]))`;
          const response = await fetch(
            `http://127.0.0.1:${port.HostPort}/api/v1/query?query=${encodeURIComponent(query)}`,
            { signal: AbortSignal.timeout(30000) }
          );
          assert.ok(response.ok);
          const data: any = await response.json();
          assert.equal(data.status, "success");
          result[id][label] = Number(data.data.result[0]?.value[1] ?? 0);
        }
      }
      return result;
    }
    try {
      await idle();
      let submitted: any = { id: evidence.experimentId };
      let original: any;
      const fingerprint = (value: unknown) =>
        crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
      if (!resumed) {
        const scenario = JSON.parse(
          fs.readFileSync("examples/scenarios/parkbench-banking-writes.json", "utf8")
        );
        scenario.id = "feature026-actions-" + nonce;
        scenario.name = "Feature 026 owned action validation";
        scenario.phases = { warmupSeconds: 20, measurementSeconds: 40, cooldownSeconds: 10 };
        scenario.workload.load.concurrency = 1;
        fs.writeFileSync(source, JSON.stringify(scenario), { flag: "wx" });
        sourceOwned = true;
        const preview = await request(
          "POST",
          "/experiments/preview",
          {
            contractVersion: "experiment-schedule.v2",
            runName: "f026-actions-" + nonce.slice(0, 8),
            scenarioSourceId: scenarioSourceId(name),
            dimensions: [{ name: "-B", values: [65536, 131072] }],
            repetitions: 2,
            inputs: {
              seed: "input:seeds/twentyeight_gb_lnx",
              applicationArchive: "input:archives/parkbench-runner.zip"
            }
          },
          undefined,
          200
        );
        submitted = await request("POST", "/experiments/submit", {
          previewId: preview.previewId,
          confirm: true
        });
        evidence.experimentId = submitted.id;
        evidence.runIds = submitted.runs.map((r: any) => r.id);
        save();
        assert.equal(evidence.runIds.length, 4);
        original = identity(await runs());
        evidence.originalScheduleHash = fingerprint(original);
        evidence.originalSchedule = original.map(({ inputs, scenario, ...run }: any) => ({
          ...run,
          scenario: {
            id: scenario.id,
            version: scenario.version,
            phases: scenario.phases,
            sha256: fingerprint(scenario)
          },
          inputs: {
            seed: "input:seeds/twentyeight_gb_lnx",
            applicationArchive: "input:archives/parkbench-runner.zip"
          }
        }));
        save();
        await request("POST", `/queue/runs/${evidence.runIds[3]}/cancel`, {});
        await request("POST", "/queue/start", {});
      } else {
        original = identity(await runs());
        assert.equal(
          fingerprint(original),
          evidence.originalScheduleHash,
          "original schedule must match its pre-execution fingerprint before continuation"
        );
        save();
      }
      const before = await finish();
      await idle();
      assert.ok(before.some((r) => r.state === "CANCELLED"));
      assert.ok(before.some((r) => r.measurementValidity === "VALID" && r.completeness.complete));
      evidence.initialOutcomes = before.map((r) => ({
        id: r.id,
        state: r.state,
        validity: r.measurementValidity,
        complete: r.completeness?.complete ?? false
      }));
      const sentinelId = process.env.PARKBENCH_ACTION_SENTINEL_RUN_ID;
      assert.ok(sentinelId, "use a completed validation-owned confirmation run as sentinel");
      const sentinel = await request("GET", "/runs/" + sentinelId);
      const comparison = await request(
        "POST",
        "/comparisons",
        { baselineRunId: sentinelId, variantRunIds: evidence.runIds },
        undefined,
        201
      );
      evidence.oldComparisonId = comparison.id;
      evidence.oldContextId = comparison.dashboardContextId;
      save();
      // Cancel a real deployed dialog and compare server state before accepting anything.
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(
          (process.env.PARKBENCH_CONTROL_UI_URL ?? "http://127.0.0.1:13002") +
            `/#runs/${evidence.runIds[0]}`
        );
        for (const name of ["Rerun experiment", "Remove experiment"]) {
          await page.getByRole("button", { name, exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor({ state: "visible" });
          assert.ok((await dialog.textContent())!.includes("4 runs"));
          await page
            .getByRole("dialog")
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          assert.deepEqual(identity(await runs()), original);
        }
      } finally {
        await browser.close();
      }
      // A quiescent restart disables queue processing, allowing inspection of the clean reset.
      await restartController();
      const selected = evidence.runIds[3],
        siblings = evidence.runIds.slice(0, 3);
      const unaffected = await request(
        "POST",
        "/comparisons",
        { baselineRunId: sentinelId, variantRunIds: siblings },
        undefined,
        201
      );
      const summaryDeadline = Date.now() + 180000;
      for (;;) {
        const db = new DatabaseSync(path.resolve(".parkbench/parkbench.sqlite"), {
          readOnly: true
        });
        let ready = false;
        try {
          ready = siblings.every(
            (id: string) =>
              (
                db
                  .prepare("SELECT status FROM run_comparison_summaries WHERE run_id=?")
                  .get(id) as any
              )?.status === "READY"
          );
        } finally {
          db.close();
        }
        if (ready) break;
        assert.ok(
          Date.now() < summaryDeadline,
          "sibling source summaries must settle before immutable inventory"
        );
        await pause(1000);
      }
      const sourceBefore = siblingInventory(siblings),
        samplesBefore = await prometheusSourceCounts(siblings);
      assert.ok(
        siblings.every((id: string) => samplesBefore[id].run_id > 0),
        "initial siblings must have real source samples"
      );
      const singleBefore = await runs();
      await action("RERUN", selected);
      const singleReset = await runs();
      assert.deepEqual(identity(singleReset), original);
      assert.equal(singleReset.filter((r: any) => r.state === "QUEUED").length, 1);
      assert.equal(singleReset[3].id, selected);
      assert.notEqual(singleReset[3].executionRevision, singleBefore[3].executionRevision);
      assert.deepEqual(siblingInventory(siblings), sourceBefore);
      assert.deepEqual(await prometheusSourceCounts(siblings), samplesBefore);
      await request("GET", "/comparisons/" + comparison.id, undefined, undefined, 410);
      await request("GET", "/comparisons/" + unaffected.id);
      assert.equal(fs.existsSync(path.resolve(".parkbench/artifacts", selected)), false);
      await request("POST", "/queue/start", {});
      const individual = await finish();
      await idle();
      assert.equal(individual[3].state, "SUCCEEDED");
      assert.equal(individual[3].measurementValidity, "VALID");
      assert.equal(individual[3].completeness?.complete, true);
      assert.deepEqual(siblingInventory(siblings), sourceBefore);
      assert.deepEqual(await prometheusSourceCounts(siblings), samplesBefore);
      await restartController();
      assert.deepEqual(siblingInventory(siblings), sourceBefore);
      await request("GET", "/comparisons/" + comparison.id, undefined, undefined, 410);
      await request("GET", "/comparisons/" + unaffected.id);
      evidence.individual = {
        selectedRunId: selected,
        selectedState: individual[3].state,
        selectedValidity: individual[3].measurementValidity,
        selectedComplete: individual[3].completeness.complete,
        siblingsBefore: sourceBefore,
        siblingsAfter: siblingInventory(siblings),
        samplesBefore,
        samplesAfter: await prometheusSourceCounts(siblings),
        unaffectedComparisonId: unaffected.id
      };
      save();
      await action("RERUN");
      await request("GET", "/comparisons/" + unaffected.id, undefined, undefined, 410);
      const reset = await runs();
      assert.deepEqual(identity(reset), original);
      evidence.resetScheduleHash = fingerprint(identity(reset));
      assert.ok(reset.every((r) => r.state === "QUEUED" && !r.startedAt && !r.finishedAt));
      evidence.replacementRevision = reset[0].executionRevision;
      assert.ok(reset.every((r) => r.executionRevision === evidence.replacementRevision));
      assert.notEqual(reset[0].executionRevision, before[0].executionRevision);
      for (const id of evidence.runIds)
        assert.equal(fs.existsSync(path.resolve(".parkbench/artifacts", id)), false);
      await request("GET", "/comparisons/" + comparison.id, undefined, undefined, 410);
      await request(
        "GET",
        "/dashboards/context/" + comparison.dashboardContextId,
        undefined,
        undefined,
        410
      );
      await request("POST", "/queue/start", {});
      const replaced = await finish();
      await idle();
      evidence.replacementOutcomes = replaced.map((r) => ({
        id: r.id,
        state: r.state,
        validity: r.measurementValidity,
        complete: r.completeness?.complete ?? false
      }));
      save();
      // This is the action/identity proof. Preserve every actual quality outcome;
      // the separate writer campaign requires every consecutive run to be VALID.
      assert.ok(
        replaced.every(
          (r) =>
            ["SUCCEEDED", "THRESHOLD_FAILED"].includes(r.state) &&
            r.executionRevision === evidence.replacementRevision &&
            (r.measurementValidity !== "VALID" || r.completeness.complete)
        )
      );
      assert.ok(replaced.some((r) => r.measurementValidity === "VALID" && r.completeness.complete));
      await restartController();
      await request("GET", "/comparisons/" + comparison.id, undefined, undefined, 410);
      await request("GET", "/comparisons/" + comparison.id + "/export", undefined, undefined, 410);
      await request("GET", "/comparisons/" + unaffected.id + "/export", undefined, undefined, 410);
      const fresh = await request(
        "POST",
        "/comparisons",
        { baselineRunId: sentinelId, variantRunIds: evidence.runIds },
        undefined,
        201
      );
      evidence.freshComparisonId = fresh.id;
      await action("REMOVE");
      await restartController();
      for (const id of evidence.runIds) {
        await request("GET", "/runs/" + id, undefined, undefined, 404);
        await request("GET", "/history/runs/" + id, undefined, undefined, 404);
        await request("GET", "/runs/" + id + "/artifacts", undefined, undefined, 404);
        assert.equal(fs.existsSync(path.resolve(".parkbench/artifacts", id)), false);
        for (const command of [
          ["ps", "-aq"],
          ["volume", "ls", "-q"],
          ["network", "ls", "-q"]
        ]) {
          const { stdout } = await execute("docker", [
            ...command,
            "--filter",
            `label=parkbench.run_id=${id}`
          ]);
          assert.equal(stdout.trim(), "");
        }
      }
      await request("GET", "/experiments/" + submitted.id, undefined, undefined, 404);
      const stable = ({ health, dashboardContext, evidence, ...run }: any) => run;
      assert.deepEqual(stable(await request("GET", "/runs/" + sentinelId)), stable(sentinel));
      const surviving = await request("GET", "/comparisons/" + fresh.id);
      assert.equal(surviving.unavailableMemberCount, 4);
      assert.equal(surviving.baselineRunId, sentinelId);
      for (const route of ["/queue", "/history/runs"]) {
        const view = JSON.stringify(await request("GET", route));
        for (const id of [submitted.id, ...evidence.runIds]) assert.ok(!view.includes(id), route);
      }
      const { stdout: promIds } = await execute("docker", [
        "ps",
        "-q",
        "--filter",
        "label=com.docker.compose.project=parkbench-platform",
        "--filter",
        "label=com.docker.compose.service=prometheus"
      ]);
      assert.equal(promIds.trim().split("\n").length, 1);
      const [prom] = JSON.parse((await execute("docker", ["inspect", promIds.trim()])).stdout);
      const port = prom.NetworkSettings.Ports["9090/tcp"].find(
        (p: any) => p.HostIp === "127.0.0.1"
      );
      assert.ok(port, "require local-only Prometheus API");
      const admin = new HttpExperimentMetricAdmin(
        `http://127.0.0.1:${port.HostPort}`,
        365 * 86400,
        fetch,
        () => prometheusStorageBounds(prom.Id)
      );
      await admin.preflight();
      await admin.verify(await admin.inventory(submitted.id, evidence.runIds));
      evidence.postRestartMetricSamples = "ABSENT";
      const db = new DatabaseSync(path.resolve(".parkbench/parkbench.sqlite"), { readOnly: true });
      try {
        for (const table of [
          "experiments",
          "runs",
          "variants",
          "control_experiments",
          "control_run_metadata",
          "control_previews",
          "control_command_results",
          "idempotency_keys",
          "experiment_actions",
          "experiment_action_pages"
        ])
          for (const row of db.prepare(`SELECT * FROM ${table}`).iterate())
            for (const id of [submitted.id, ...evidence.runIds])
              assert.ok(!JSON.stringify(row).includes(id), table);
      } finally {
        db.close();
      }
      evidence.status = "PASSED";
      evidence.finishedAt = new Date().toISOString();
      save();
    } catch (error) {
      evidence.status = "FAILED";
      evidence.error = String(error);
      save();
      throw error;
    } finally {
      if (sourceOwned && fs.existsSync(source)) fs.unlinkSync(source);
    }
  }
);
