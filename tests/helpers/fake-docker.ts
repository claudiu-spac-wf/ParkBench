import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { delimiter } from "node:path";

export interface FakeDockerCall {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface FakeDockerOptions {
  responses?: Record<string, string>;
  engineId?: string;
  composeConfig?: unknown;
  status?: number;
}

export interface FakeDocker {
  root: string;
  executable: string;
  env: NodeJS.ProcessEnv;
  calls(): FakeDockerCall[];
  cleanup(): void;
}

const FAKE_DOCKER_PROGRAM = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const call = { args, cwd: process.cwd(), env: { ...process.env } };
fs.appendFileSync(process.env.FAKE_DOCKER_CALLS, JSON.stringify(call) + "\\n");
const responses = JSON.parse(process.env.FAKE_DOCKER_RESPONSES || "{}");
const key = args.join(" ");
if (Object.prototype.hasOwnProperty.call(responses, key)) {
  process.stdout.write(String(responses[key]));
  process.exit(Number(process.env.FAKE_DOCKER_STATUS || "0"));
}
if (key === "--version") process.stdout.write("Docker version 29.0.0, build fixture\\n");
else if (key === "info --format {{.ID}}") process.stdout.write(process.env.FAKE_DOCKER_ENGINE_ID + "\\n");
else if (key === "compose version --short") process.stdout.write("5.5.1\\n");
else if (key === "compose config --format json") process.stdout.write(process.env.FAKE_DOCKER_COMPOSE_CONFIG + "\\n");
else if (process.env.FAKE_DOCKER_STDOUT) process.stdout.write(process.env.FAKE_DOCKER_STDOUT);
process.exit(Number(process.env.FAKE_DOCKER_STATUS || "0"));
`;

export function createFakeDocker(options: FakeDockerOptions = {}): FakeDocker {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-fake-docker-"));
  const bin = path.join(root, "bin");
  const executable = path.join(bin, "docker");
  const callsFile = path.join(root, "calls.jsonl");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(executable, FAKE_DOCKER_PROGRAM, { mode: 0o755 });
  fs.chmodSync(executable, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_DOCKER_CALLS: callsFile,
    FAKE_DOCKER_RESPONSES: JSON.stringify(options.responses ?? {}),
    FAKE_DOCKER_STATUS: String(options.status ?? 0),
    FAKE_DOCKER_ENGINE_ID: options.engineId ?? "fake-engine-id",
    FAKE_DOCKER_COMPOSE_CONFIG: JSON.stringify(options.composeConfig ?? { services: {} })
  };

  return {
    root,
    executable,
    env,
    calls() {
      if (!fs.existsSync(callsFile)) return [];
      return fs
        .readFileSync(callsFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line: string) => JSON.parse(line) as FakeDockerCall);
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
