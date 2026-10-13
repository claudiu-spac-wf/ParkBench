import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DockerComposeOrchestrator } from "../../packages/compose-runner/src/orchestrator";
import { classifyLoadgenExitCode } from "../../apps/control-plane/src/runs/failure-classifier";
import { createFakeDocker } from "../helpers/fake-docker";
import { createTemporaryPathFixture, withEnvironment } from "../helpers/environment-fixture";

describe("run observer host ports", () => {
  it("records the load generator's published port for the host-side core observer", async () => {
    const fixture = createTemporaryPathFixture("parkbench-loadgen-port-");
    const runRoot = fixture.resolve("runs");
    fs.mkdirSync(runRoot, { recursive: true });
    const projectName = "parkbench-port-fixture";
    const docker = createFakeDocker({
      responses: {
        [`compose -p ${projectName} -f ${path.join(runRoot, `${projectName}.yml`)} port loadgen 9100`]:
          "127.0.0.1:43127\n"
      }
    });
    const bundle: any = { projectName, observerPorts: {} };
    try {
      await withEnvironment(docker.env, () =>
        new DockerComposeOrchestrator(runRoot, docker.executable).startWorkload(bundle)
      );
      assert.equal(bundle.observerPorts.loadgen, 43127);
    } finally {
      docker.cleanup();
      fixture.cleanup();
    }
  });

  it("fails with a bounded error instead of using an unreachable service DNS name", async () => {
    const fixture = createTemporaryPathFixture("parkbench-loadgen-port-missing-");
    const runRoot = fixture.resolve("runs");
    fs.mkdirSync(runRoot, { recursive: true });
    const docker = createFakeDocker();
    const bundle: any = { projectName: "parkbench-port-missing", observerPorts: {} };
    try {
      await withEnvironment(docker.env, async () => {
        await assert.rejects(
          new DockerComposeOrchestrator(runRoot, docker.executable).startWorkload(bundle),
          /observer_host_port_unavailable:loadgen/
        );
      });
    } finally {
      docker.cleanup();
      fixture.cleanup();
    }
  });

  it("stops a load generator that has not exited after cooldown", async () => {
    const fixture = createTemporaryPathFixture("parkbench-loadgen-exit-");
    const runRoot = fixture.resolve("runs");
    fs.mkdirSync(runRoot, { recursive: true });
    const docker = createFakeDocker();
    const bundle: any = { projectName: "parkbench-loadgen-exit" };
    try {
      const exitCode = await withEnvironment(docker.env, () =>
        new DockerComposeOrchestrator(runRoot, docker.executable)
          .waitForWorkload(bundle, () => false, 50)
      );
      assert.equal(exitCode, 124);
      assert.deepEqual(classifyLoadgenExitCode(exitCode), {
        state: "FAILED",
        failureKind: "infrastructure",
        reason: "loadgen did not exit after cooldown"
      });
      assert.ok(docker.calls().some((call) => call.args.includes("stop") &&
        call.args.includes("loadgen")));
    } finally {
      docker.cleanup();
      fixture.cleanup();
    }
  });
});
