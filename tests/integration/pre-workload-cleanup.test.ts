import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerComposeOrchestrator } from "../../packages/compose-runner/src/orchestrator";
import type { ComposeBundle } from "../../packages/compose-runner/src/run-compose";

test("cleanup removes a run whose load generator was never started", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-early-cleanup-"));
  const runId = "run_early";
  const experimentId = "exp_early";
  const projectName = "parkbench-run-early";
  const labels = { "parkbench.managed": "true", "parkbench.run_id": runId,
    "parkbench.experiment_id": experimentId };
  const bundle: ComposeBundle = { projectName, file: "", metricsNetworkName: "test-metrics",
    localPaths: [], resources: [{ type: "compose_project", name: projectName, labels }],
    scenario: {} as ComposeBundle["scenario"] };
  const resources = [
    { resourceType: "compose_project" as const, resourceId: projectName, labels,
      createdAt: new Date().toISOString() },
    { resourceType: "container" as const, resourceId: "database", labels,
      createdAt: new Date().toISOString() },
    { resourceType: "container" as const, resourceId: "loadgen", labels,
      createdAt: new Date().toISOString() }
  ];
  const orchestrator = new DockerComposeOrchestrator(root);
  let downCalled = false;
  (orchestrator as any).command = async (args: string[]) => {
    if (args[0] === "compose" && args[1] === "ls")
      return { stdout: downCalled ? "[]" : JSON.stringify([{ Name: projectName }]), stderr: "" };
    if (args.includes("down")) {
      downCalled = true;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      if (args[2].endsWith("-loadgen-1") || downCalled)
        return { stdout: "[]", stderr: "Error: No such container" };
      return { stdout: JSON.stringify([{ Config: { Labels: labels } }]), stderr: "" };
    }
    throw new Error(`unexpected_docker_command:${args.join(" ")}`);
  };
  try {
    const cleaned = await orchestrator.cleanup(bundle, resources);
    assert.equal(downCalled, true);
    assert.ok(cleaned.every((resource) => resource.cleanupResult === "deleted"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
