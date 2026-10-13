#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseEnvFile } = require("./lib/load-env.cjs");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function collectSensitiveValues(root = REPO_ROOT, environment = process.env) {
  const envFile = environment.PARKBENCH_ENV_FILE || ".env.local";
  const resolvedEnvFile = path.isAbsolute(envFile) ? envFile : path.resolve(root, envFile);
  const parsed = parseEnvFile(resolvedEnvFile);
  const values = Object.entries(parsed.values)
    .filter(([key]) => isSensitiveSetting(key))
    .map(([, value]) => value);
  values.push(
    ...Object.entries(environment)
      .filter(([key, value]) => isSensitiveSetting(key) && typeof value === "string")
      .map(([, value]) => value)
  );
  for (const [key, value] of Object.entries(parsed.values)) {
    if (!/(?:LICENSE|SEED|ARCHIVE|CREDENTIAL|PRIVATE_INPUT)/i.test(key) || !value) continue;
    const inputPath = path.isAbsolute(value) ? value : path.resolve(root, value);
    try {
      const stat = fs.statSync(inputPath);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const contents = fs.readFileSync(inputPath, "utf8");
      values.push(contents, ...contents.split(/\r?\n/));
    } catch {
      // The relevant preflight owns missing or unreadable input errors.
    }
  }
  return [...new Set(values.filter((value) => value.length >= 4))];
}

function isSensitiveSetting(key) {
  return /(?:PASSWORD|PASSWD|SECRET|TOKEN|AUTHORIZATION|CREDENTIAL|PRIVATE[ _-]?KEY|LICENSE|SEED|ARCHIVE|PRIVATE_INPUT)/i.test(
    key
  );
}

export function redactDiagnosticText(value, additionalSecrets = []) {
  let result = String(value);
  for (const secret of additionalSecrets.filter(
    (entry) => typeof entry === "string" && entry.length >= 4
  ))
    result = result.replaceAll(secret, "[REDACTED]");
  return result
    .replaceAll(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[REDACTED]@")
    .replaceAll(
      /(password|secret|token|authorization|credential|private[ _-]?key)\s*([:=])\s*([^\s,;]+)/gi,
      "$1$2[REDACTED]"
    )
    .replaceAll(/\/(?:home|Users)\/[^/\s]+/g, "<home>")
    .replaceAll(/\/mnt\/[a-zA-Z]\/Users\/[^/\s]+/g, "<windows-home>")
    .replaceAll(/[A-Za-z]:\\Users\\[^\\\s]+/g, "<windows-home>")
    .replaceAll(/\/[^\s"']*progress\.cfg/gi, "<redacted-license>");
}

function main() {
  const input = fs.readFileSync(0, "utf8");
  const secrets = collectSensitiveValues(REPO_ROOT, process.env);
  process.stdout.write(redactDiagnosticText(input, secrets));
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main();
}
