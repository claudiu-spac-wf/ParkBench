import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROMETHEUS_IMAGE } from "./support/fixture-prometheus";
const enabled = process.env.PARKBENCH_RUN_GRAFANA_INTEGRATION === "1";
describe("generated dashboard recording rules", { skip: !enabled, timeout: 120_000 }, () => {
  it("pass promtool without publishing table ranking or biased activity", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-rules-")),
      suffix = randomUUID(),
      volume = `parkbench-rules-${suffix}`,
      container = `parkbench-rules-import-${suffix}`;
    const docker = (args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" });
    try {
      const rules = fs.readFileSync("deploy/prometheus/rules/parkbench-dashboards.yml", "utf8");
      assert.doesNotMatch(rules, /table_tiebreak|record:/);
      fs.writeFileSync(path.join(directory, "rules.yml"), rules);
      fs.writeFileSync(
        path.join(directory, "test.yml"),
        "rule_files: [rules.yml]\nevaluation_interval: 15s\ntests:\n  - interval: 15s\n    input_series: []\n    promql_expr_test:\n      - expr: parkbench:table_tiebreak_bias\n        eval_time: 1m\n        exp_samples: []\n"
      );
      docker(["volume", "create", volume]);
      docker([
        "create",
        "--name",
        container,
        "--user",
        "0",
        "-v",
        `${volume}:/data`,
        "--entrypoint",
        "true",
        PROMETHEUS_IMAGE
      ]);
      docker(["cp", path.join(directory, "rules.yml"), `${container}:/data/rules.yml`]);
      docker(["cp", path.join(directory, "test.yml"), `${container}:/data/test.yml`]);
      const run = (...args: string[]) =>
        docker([
          "run",
          "--rm",
          "-v",
          `${volume}:/data:ro`,
          "-w",
          "/data",
          "--entrypoint",
          "promtool",
          PROMETHEUS_IMAGE,
          ...args
        ]);
      assert.match(run("check", "rules", "rules.yml"), /SUCCESS/);
      assert.match(run("test", "rules", "test.yml"), /SUCCESS/);
    } finally {
      try {
        docker(["rm", "-f", container]);
      } catch {}
      try {
        docker(["volume", "rm", volume]);
      } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
