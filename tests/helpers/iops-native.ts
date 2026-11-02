import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  EngineApi,
  DatabaseIopsInspector,
  DockerComposeOrchestrator,
  IOPS_PROBE_SCRIPT
} from "../../packages/compose-runner/src";
import {
  resolveDatabaseIops,
  DatabaseIopsPresetId
} from "../../packages/contracts/src/database-iops";
import { ArtifactStorage } from "../../apps/control-plane/src/artifacts/storage";
const execute = promisify(execFile);
export const nativeDocker = async (args: string[], timeout = 120000) => {
  try {
    return (
      await execute("docker", args, { encoding: "utf8", timeout, maxBuffer: 1048576 })
    ).stdout.trim();
  } catch (error) {
    throw Error(
      `iops_validation_docker_unavailable:${args[0]}:${(error as any).code ?? "unknown"}`
    );
  }
};
export async function createIopsFixture(image: string) {
  if (!image || image.endsWith(":latest") || !image.includes(":"))
    throw Error("iops_validation_explicit_image_required");
  const runId = `f025-storage-${crypto.randomUUID().slice(0, 8)}`,
    projectName = `parkbench-${runId}`,
    volume = projectName + "-data",
    name = projectName + "-db";
  const labels = {
    "parkbench.managed": "true",
    "parkbench.run_id": runId,
    "parkbench.experiment_id": runId,
    "parkbench.variant_id": "storage",
    "parkbench.component": "database",
    "com.docker.compose.project": projectName,
    "com.docker.compose.service": "database"
  };
  const flags = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  let id: string;
  let release = () => {};
  const cleanup = async () => {
    release();
    if (id) {
      const actual = JSON.parse(await nativeDocker(["inspect", id]));
      if (actual[0].Config.Labels["parkbench.run_id"] !== runId)
        throw Error("fixture_cleanup_owner_mismatch");
      await nativeDocker(["rm", "-f", id]);
    }
    const v = JSON.parse(await nativeDocker(["volume", "inspect", volume]));
    if (v[0].Labels["parkbench.run_id"] !== runId) throw Error("fixture_volume_owner_mismatch");
    await nativeDocker(["volume", "rm", volume]);
  };
  await nativeDocker(["volume", "create", ...flags, volume]);
  try {
    id = await nativeDocker([
      "run",
      "-d",
      "--name",
      name,
      ...flags,
      "--mount",
      `type=volume,source=${volume},target=/psc/wrk`,
      image
    ]);
    const api = await EngineApi.forDocker();
    const inspector = new DatabaseIopsInspector(api);
    await nativeDocker(["exec", id, "test", "-d", "/psc/wrk/fixture"]);
    const bundle: any = {
      projectName,
      variantId: "storage",
      databaseName: "fixture",
      resources: [{ type: "container", name, labels }],
      scenario: {},
      metricsNetworkName: "unused",
      localPaths: [],
      file: ""
    };
    const orchestrator = new DockerComposeOrchestrator();
    release = () => orchestrator.releaseDatabaseIops(projectName);
    const folder = path.resolve(".parkbench/validation/feature025/storage", runId);
    const storage = new ArtifactStorage(folder);
    const snapshot = () =>
      inspector.snapshot(id, projectName, runId, "fixture", Date.now() + 10000, true);
    return {
      id,
      runId,
      volume,
      api,
      inspector,
      bundle,
      folder,
      orchestrator,
      cleanup,
      snapshot,
      runtimeWorkerId() {
        return (orchestrator as any).iopsContexts.get(projectName)?.inspector.runtimeWorkerId;
      },
      async apply(preset: DatabaseIopsPresetId) {
        return orchestrator.applyDatabaseIops(
          bundle,
          resolveDatabaseIops(preset),
          () => false,
          async (intent) => {
            storage.writeAtomic("intent.json", JSON.stringify(intent));
            storage.writeAtomic(
              "intent-reference.json",
              JSON.stringify({ attemptId: intent.attemptId, pending: true })
            );
          }
        );
      },
      async counters() {
        const data = await api.inspect(id);
        const reader = await nativeDocker([
          "ps",
          "-q",
          "--filter",
          "label=com.docker.compose.project=parkbench-platform",
          "--filter",
          "label=com.docker.compose.service=cadvisor"
        ]);
        if (!/^[a-f0-9]{12,64}$/.test(reader)) throw Error("fixture_host_reader_missing");
        const full = JSON.parse(await nativeDocker(["inspect", reader]))[0].Id;
        const text = await nativeDocker(
          [
            "exec",
            full,
            "sh",
            "-c",
            IOPS_PROBE_SCRIPT,
            "iops-validation",
            String(data.State.Pid),
            id,
            "/psc/wrk/fixture",
            "validation"
          ],
          10000
        );
        if (!text.includes(`OWNER\t${data.State.Pid}\t${id}`))
          throw Error("fixture_counter_owner_unconfirmed");
        const counters = Object.fromEntries(
          text
            .split("\n")
            .filter((l) => l.startsWith("STAT\t"))
            .map((l) => {
              const [device, ...fields] = l.slice(5).split(/\s+/);
              return [
                device,
                Object.fromEntries(
                  fields.map((f) => {
                    const [k, v] = f.split("=");
                    return [k, Number(v)];
                  })
                )
              ];
            })
        );
        return { at: Date.now(), counters };
      }
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
