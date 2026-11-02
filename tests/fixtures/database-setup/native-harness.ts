import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
/** Native command spies run only on temporary public fixture state. */
export function nativeSetupHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-setup-"));
  for (const dir of ["bin", "database", "output", "control", "scripts"])
    fs.mkdirSync(path.join(root, dir));
  const driver = path.join(root, "bin", "driver.cjs");
  const source = path.resolve("tests/fixtures/database-setup");
  fs.copyFileSync(path.join(source, "native-driver.cjs"), driver);
  fs.chmodSync(driver, 0o755);
  fs.copyFileSync(path.join(source, "broker.cjs"), path.join(root, "bin", "broker.cjs"));
  for (const name of ["proutil", "proserve", "proshut", "mpro", "pgrep"])
    fs.symlinkSync(driver, path.join(root, "bin", name));
  const env = {
    ...process.env,
    SETUP_FIXTURE_ROOT: root,
    PATH: path.join(root, "bin") + path.delimiter + process.env.PATH
  };
  return {
    root,
    env,
    database: path.join(root, "database"),
    control: path.join(root, "control"),
    output: path.join(root, "output"),
    failStatusWrites() {
      fs.rmSync(path.join(root, "output"), { recursive: true, force: true });
      fs.writeFileSync(path.join(root, "output"), "unwritable fixture output directory");
    },
    failLogWrites(name: string) {
      fs.symlinkSync("/dev/full", path.join(root, "output", name));
    },
    write(name: string, value: string | number) {
      fs.writeFileSync(path.join(root, "control", name), String(value));
    },
    events() {
      try {
        return fs
          .readFileSync(path.join(root, "events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
      } catch {
        return [];
      }
    },
    command(name: string, args: string[] = []) {
      return execFileSync(path.join(root, "bin", name), args, {
        env,
        cwd: path.join(root, "database"),
        encoding: "utf8"
      });
    },
    script(name: string, body: string) {
      const file = path.join(root, "scripts", name);
      fs.writeFileSync(file, "#!/bin/sh\n" + body, { mode: 0o755 });
      return file;
    },
    close() {
      try {
        const pid = Number(fs.readFileSync(path.join(root, "control", "broker.pid"), "utf8"));
        process.kill(pid, "SIGTERM");
      } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
