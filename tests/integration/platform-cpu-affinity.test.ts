import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import scenario from "../../examples/scenarios/parkbench-bank-mix.json";
import { generateRunCompose } from "../../packages/compose-runner/src";
import { withEnvironment } from "../helpers/environment-fixture";
import { imageReference } from "../helpers/openedge";

const root = process.cwd();

function generateRun() {
  return generateRunCompose(
    "cpu-affinity",
    "exp-cpu-affinity",
    { ...(scenario as any), target: { ...(scenario as any).target, pasReplicas: 2 } },
    { db: imageReference("db", "test"), pas: imageReference("pas", "test") },
    {
      loadgenImage: imageReference("loadgen", "test"),
      observerImage: imageReference("observer", "test")
    }
  ).file;
}

function serviceBlock(compose: string, service: string): string {
  const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = compose.match(
    new RegExp(`  ${escaped}:([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:|\\nnetworks:)`)
  );
  assert.ok(match, `missing service ${service}`);
  return match[1];
}

describe("Docker CPU affinity configuration", () => {
  it("pins the DB, each PAS target, and platform helpers to configured CPU IDs", async () => {
    await withEnvironment(
      {
        PARKBENCH_PLATFORM_CPUSET: "0,1,2,3",
        PARKBENCH_PAS_CPUSET: "4,5",
        PARKBENCH_DB_CPUSET: "6,7"
      },
      () => {
        const compose = generateRun();
        assert.match(serviceBlock(compose, "database"), /cpuset: "6,7"/);
        assert.match(serviceBlock(compose, "pas-1"), /cpuset: "4,5"/);
        assert.match(serviceBlock(compose, "pas-2"), /cpuset: "4,5"/);
        for (const service of ["loadgen", "db-observer", "pas-observer", "file-sampler"])
          assert.match(serviceBlock(compose, service), /cpuset: "0,1,2,3"/, service);
      }
    );
  });

  it("leaves run services unpinned when CPU-set values are empty", async () => {
    await withEnvironment(
      {
        PARKBENCH_PLATFORM_CPUSET: "",
        PARKBENCH_PAS_CPUSET: "",
        PARKBENCH_DB_CPUSET: ""
      },
      () => assert.doesNotMatch(generateRun(), /^\s+cpuset:/m)
    );
  });

  it("rejects invalid CPU-set syntax and overlapping isolation groups", async () => {
    await withEnvironment(
      {
        PARKBENCH_PLATFORM_CPUSET: "0-3",
        PARKBENCH_PAS_CPUSET: "3,4",
        PARKBENCH_DB_CPUSET: ""
      },
      () => assert.throws(generateRun, /cpu_affinity_overlap:PARKBENCH_PAS_CPUSET/)
    );
    await withEnvironment(
      {
        PARKBENCH_PLATFORM_CPUSET: "0,2,,3",
        PARKBENCH_PAS_CPUSET: "",
        PARKBENCH_DB_CPUSET: ""
      },
      () => assert.throws(generateRun, /cpu_affinity_invalid:PARKBENCH_PLATFORM_CPUSET/)
    );
  });

  it("assigns the platform CPU set to every persistent platform service", () => {
    const compose = fs.readFileSync(path.join(root, "deploy/platform-compose.yml"), "utf8");
    for (const service of [
      "control-plane",
      "web",
      "prometheus",
      "grafana",
      "cadvisor",
      "node-exporter"
    ]) {
      const block = serviceBlock(compose, service);
      assert.match(block, /cpuset: "\$\{PARKBENCH_PLATFORM_CPUSET:-\}"/, service);
    }
    assert.match(
      compose,
      /\$\{PARKBENCH_DOCKER_SOCKET_PATH:-\/var\/run\/docker\.sock\}:\/var\/run\/docker\.sock/
    );
  });
});


describe("Database memory containment", () => {
  it("applies a hard configurable cap and prevents extra swap only on the database", async () => {
    await withEnvironment({PARKBENCH_DB_MEMORY_LIMIT:"9g"}, () => {
      const compose=generateRun();
      assert.match(serviceBlock(compose,"database"), /mem_limit: "9g"/);
      assert.match(serviceBlock(compose,"database"), /memswap_limit: "9g"/);
      for(const service of ["pas-1","pas-2","loadgen","db-observer","pas-observer","file-sampler"])
        assert.doesNotMatch(serviceBlock(compose,service), /mem(?:swap)?_limit:/);
    });
  });
  it("defaults to 10 GiB and rejects unlimited, malformed, and too-small limits before creating containers", async () => {
    await withEnvironment({PARKBENCH_DB_MEMORY_LIMIT:undefined}, () => assert.match(serviceBlock(generateRun(),"database"), /mem_limit: "10g"/));
    for(const invalid of ["", "0", "0g", "-1g", "1m", "infinity", "2g\\n    privileged: true"])
      await withEnvironment({PARKBENCH_DB_MEMORY_LIMIT:invalid}, () => assert.throws(generateRun,/platform_setting_invalid:PARKBENCH_DB_MEMORY_LIMIT/));
  });
});
