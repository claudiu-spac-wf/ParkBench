import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

describe("Ubuntu bootstrap retry safety", () => {
  it("removes only its own temporary stage and preserves unrelated local state across retry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-bootstrap-recovery-"));
    const outputRoot = path.join(root, "openedge-output");
    const progressRoot = path.join(root, "IMAGES");
    const workloadRoot = path.join(root, "workloads");
    const licensePath = path.join(root, "progress.cfg");
    const unrelatedRoot = path.join(root, "unrelated");
    for (const directory of [progressRoot, workloadRoot, unrelatedRoot])
      fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(progressRoot, "base-image.marker"), "private input marker");
    fs.writeFileSync(licensePath, "private license marker");
    const preserved = [
      [".env.local", "local-config"],
      ["prior-run-evidence.json", "prior-evidence"],
      ["containers/unrelated.json", "container-state"],
      ["images/unrelated.txt", "image-state"],
      ["volumes/unrelated.txt", "volume-state"]
    ];
    for (const [file, value] of preserved) {
      const destination = path.join(unrelatedRoot, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, value);
    }

    const stagingModule = pathToFileURL(
      path.join(process.cwd(), "scripts/openedge/stage-inputs.mjs")
    ).href;
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { stageInputs, cleanupPrivateStage } from ${JSON.stringify(stagingModule)};
      const [outputRoot, progressRoot, license, workloadRoot] = process.argv.slice(1);
      const unrelatedStage = path.join(outputRoot, "staging", "operator-owned");
      fs.mkdirSync(unrelatedStage, { recursive: true });
      fs.writeFileSync(path.join(unrelatedStage, "keep.txt"), "keep");
      const first = stageInputs({ outputRoot, progressRoot, license, workloadRoot }, "generic", {});
      fs.writeFileSync(path.join(first.stageRoot, "generated.tmp"), "first attempt");
      if (!cleanupPrivateStage(first)) process.exit(21);
      const retry = stageInputs({ outputRoot, progressRoot, license, workloadRoot }, "generic", {});
      fs.writeFileSync(path.join(retry.stageRoot, "generated.tmp"), "retry attempt");
      const result = {
        firstStageRemoved: !fs.existsSync(first.stageRoot),
        retryIsUnique: retry.stageRoot !== first.stageRoot,
        operatorStagePreserved: fs.existsSync(path.join(unrelatedStage, "keep.txt")),
        retryRemoved: cleanupPrivateStage(retry) && !fs.existsSync(retry.stageRoot)
      };
      console.log(JSON.stringify(result));
    `;

    try {
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            script,
            outputRoot,
            progressRoot,
            licensePath,
            workloadRoot
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8"
          }
        )
      );
      assert.deepEqual(result, {
        firstStageRemoved: true,
        retryIsUnique: true,
        operatorStagePreserved: true,
        retryRemoved: true
      });
      for (const [file, expected] of preserved) {
        assert.equal(fs.readFileSync(path.join(unrelatedRoot, file), "utf8"), expected, file);
      }
      assert.equal(
        fs.readFileSync(path.join(outputRoot, "staging/operator-owned/keep.txt"), "utf8"),
        "keep"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
