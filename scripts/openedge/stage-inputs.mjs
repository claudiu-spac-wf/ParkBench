import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("../lib/load-env.cjs").loadEnvironment();

export function writeAtomic(file, value, encoding = "utf8") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, value, encoding);
  fs.renameSync(temporary, file);
}

export function stageInputs(options, stage, resolvedImages = {}) {
  const outputRoot = path.resolve(options.outputRoot);
  const stagingRoot = path.join(outputRoot, "staging");
  const ownerToken = crypto.randomUUID();
  const stageRoot = path.join(stagingRoot, `${stage}-${ownerToken}`);
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stageRoot, { mode: 0o700 });
  fs.writeFileSync(
    path.join(stageRoot, ".parkbench-owner.json"),
    JSON.stringify({ schemaVersion: "parkbench-build-stage.v1", stage, ownerToken }),
    { mode: 0o600, flag: "wx" }
  );
  const staged = { stageRoot, stagingRoot, outputRoot, ownerToken, stage };
  try {
    const privateRoot = path.join(stageRoot, "private");
    fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const stagedLicense = path.join(privateRoot, "progress.cfg");
    fs.copyFileSync(options.license, stagedLicense, fs.constants.COPYFILE_EXCL);
    const inputs = [
      {
        kind: "license",
        reference: "private:progress.cfg",
        version: "12.8.11",
        private: true
      },
      {
        kind: "progress-assets",
        reference: "private:IMAGES",
        version: "12.8.11",
        private: true
      },
      {
        kind: "db-base",
        reference: pinnedInputReference(options.dbImage, resolvedImages.db),
        version: "12.8.11",
        private: false
      },
      {
        kind: "pasoe-base",
        reference: pinnedInputReference(options.pasoeImage, resolvedImages.pasoe),
        version: "12.8.11",
        private: false
      },
      {
        kind: "jdk-image",
        reference: pinnedInputReference(options.jdkImage, resolvedImages.jdk),
        version: "configured",
        private: false
      },
      {
        kind: "workloads",
        reference: path.relative(
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
          options.workloadRoot
        ),
        version: "source",
        private: false
      }
    ];
    return { ...staged, stagedLicense, inputs };
  } catch (error) {
    cleanupPrivateStage(staged);
    throw error;
  }
}

function pinnedInputReference(configuredReference, inspection) {
  return configuredReference;
}

export function cleanupPrivateStage(staged) {
  if (!staged || typeof staged !== "object") return false;
  const { stageRoot, stagingRoot, outputRoot, ownerToken, stage } = staged;
  if (!stageRoot || !stagingRoot || !outputRoot || !ownerToken || !stage) return false;
  const resolvedStageRoot = path.resolve(stageRoot);
  if (path.dirname(resolvedStageRoot) !== path.resolve(stagingRoot)) return false;
  if (path.resolve(stagingRoot) !== path.join(path.resolve(outputRoot), "staging")) return false;
  let owner;
  try {
    owner = JSON.parse(
      fs.readFileSync(path.join(resolvedStageRoot, ".parkbench-owner.json"), "utf8")
    );
  } catch {
    return false;
  }
  if (
    owner.schemaVersion !== "parkbench-build-stage.v1" ||
    owner.stage !== stage ||
    owner.ownerToken !== ownerToken
  )
    return false;
  fs.rmSync(resolvedStageRoot, { recursive: true, force: true });
  return true;
}

export function redacted(value) {
  return String(value)
    .replaceAll(/((?:progress\.cfg|license|password|secret)\s*=)[^\s&]*/gi, "$1<redacted>")
    .replaceAll(/\/[^\s]*progress\.cfg/gi, "<redacted-license>");
}
