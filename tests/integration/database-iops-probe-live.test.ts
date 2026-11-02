import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createIopsFixture, nativeDocker } from "../helpers/iops-native";
test(
  "direct Engine read-only probes retain exact policies within the runtime deadline under owned CPU demand",
  { skip: process.env.PARKBENCH_RUN_IOPS_TESTS !== "1", timeout: 120000 },
  async () => {
    const fixture = await createIopsFixture(process.env.PARKBENCH_IOPS_TEST_IMAGE ?? "");
    const results: any = { runId: fixture.runId, checks: [], status: "RUNNING" };
    const workers: string[] = [];
    const out = path.resolve(".parkbench/validation/feature025/storage/direct-probe.json");
    try {
      await nativeDocker([
        "exec",
        "-d",
        fixture.id,
        "node",
        "-e",
        'const {Worker}=require("node:worker_threads");for(let i=0;i<4;i++)new Worker("while(true){}",{eval:true});'
      ]);
      for (const preset of ["hdd", "sata-ssd", "slow-nvme", "fast-nvme"] as const) {
        const e = await fixture.apply(preset);
        workers.push(fixture.runtimeWorkerId());
        const ctx = (fixture.orchestrator as any).iopsContexts.get(fixture.bundle.projectName);
        const api = ctx.api;
        if (!api.probeTimings) {
          api.probeTimings = [];
          const request = api.request.bind(api);
          api.request = async (...args: any[]) => {
            const start = Date.now();
            try {
              return await request(...args);
            } finally {
              api.probeTimings.push({
                route: args[1].replace(/[a-f0-9]{64}/g, "<owned-id>"),
                durationMs: Date.now() - start
              });
            }
          };
        }

        for (let i = 0; i < 10; i++) {
          await fixture.orchestrator.checkDatabaseIops(
            fixture.bundle,
            e,
            "measurement",
            () => false
          );
          assert.ok(e.verification.durationMs <= 500);
          results.checks.push({
            preset,
            durationMs: e.verification.durationMs,
            status: e.verification.status,
            requests: api.probeTimings.splice(0)
          });
        }
      }
      const cleared = await fixture.apply("unlimited");
      assert.equal(cleared.verification.status, "NO_ADDED_CAP");
      assert.equal(cleared.applicationOutcome, "VERIFIED");
      results.ownedClear = {
        status: cleared.verification.status,
        mode: cleared.mode,
        applicationOutcome: cleared.applicationOutcome
      };
      results.status = "PASSED";
    } catch (error) {
      results.status = "FAILED";
      results.reason = String(error);
      throw error;
    } finally {
      await fixture.cleanup();
      for (const id of workers) {
        let state;
        const until = Date.now() + 2000;
        do {
          state = await fixture.api.request("GET", fixture.api.versioned(`/exec/${id}/json`));
          if (!state.Running) break;
          await new Promise((r) => setTimeout(r, 25));
        } while (Date.now() < until);
        assert.equal(state.Running, false, "owned host-reader worker stopped");
        assert.equal(state.ExitCode, 0);
      }
      results.workersStopped = workers.length;
      results.cleanup = "COMPLETE";
      fs.writeFileSync(out, JSON.stringify(results, null, 2));
    }
  }
);
