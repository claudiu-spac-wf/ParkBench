import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TemporaryPathFixture {
  root: string;
  resolve(...segments: string[]): string;
  cleanup(): void;
}

export function createTemporaryPathFixture(prefix = "parkbench-test-"): TemporaryPathFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let cleaned = false;
  return {
    root,
    resolve: (...segments) => path.join(root, ...segments),
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

export async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  action: () => T | Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function withWorkingDirectory<T>(directory: string, action: () => T | Promise<T>) {
  const original = process.cwd();
  process.chdir(directory);
  try {
    return await action();
  } finally {
    process.chdir(original);
  }
}
