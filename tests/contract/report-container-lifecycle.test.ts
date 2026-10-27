import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildReportCompose } from "../../packages/compose-runner/src/report-compose";

// Execute the generated container shell with local stand-ins for licensed commands.
// This covers orchestration and signals, without Docker or a real database seed.
for (const mode of [
  "success",
  "native-error",
  "startup-error",
  "cancel-startup",
  "cancel-analysis"
] as const)
  test(`report container lifecycle: ${mode}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-report-shell-"));
    try {
      const binary = (name: string, body: string) => {
        const file = path.join(root, name);
        fs.writeFileSync(file, "#!/bin/sh\n" + body, { mode: 0o755 });
        return file;
      };
      for (const dir of ["work/db", "reports/execution", "reports/raw"])
        fs.mkdirSync(path.join(root, dir), { recursive: true });
      const entrypoint = binary(
        "entrypoint",
        `
trap 'touch "$TEST_ROOT/stopped"; exit 0' TERM INT
touch "$TEST_ROOT/started"
if [ "$TEST_MODE" = startup-error ]; then exit 51; fi
touch "$TEST_ROOT/work/db/.parkbench-db-name"
while :; do sleep 0.05; done
`
      );
      binary("pgrep", 'test "$TEST_MODE" != cancel-startup\n');
      // First readiness observation is STARTING, then IN USE. No analysis before IN USE.
      const proutil = binary(
        "proutil",
        `
if [ "$3" = busy ]; then
  if [ ! -f "$TEST_ROOT/starting" ]; then touch "$TEST_ROOT/starting"; exit 64; fi
  touch "$TEST_ROOT/ready"
  exit 6
fi
test -f "$TEST_ROOT/ready" || exit 99
test "$1" = "$TEST_ROOT/work/db/db" || exit 98
if [ "$TEST_MODE" = cancel-analysis ]; then
  trap 'touch "$TEST_ROOT/analysis-stopped"; exit 143' TERM INT
  touch "$TEST_ROOT/analyzing"
  while :; do sleep 0.05; done
fi
touch "$TEST_ROOT/analyzing"
echo native-output > "$TEST_ROOT/reports/raw/report.table.txt"
if [ "$TEST_MODE" = native-error ]; then exit 17; fi
`
      );
      // Shorten the shell's poll interval, without changing readiness decisions.
      const sleep = binary("sleep", "/bin/sleep 0.01\n");
      const compose = buildReportCompose({
        reportId: "fixture",
        token: "owner",
        directory: root,
        seedPath: "/protected-seed",
        databaseName: "db",
        image: "db:12.8.11",
        type: "TABANALYS",
        aliases: []
      });
      const service = compose.services.analysis;
      const script = service.entrypoint[2]
        .replaceAll("$$", "$")
        .replaceAll("/usr/local/bin/parkbench-db-entrypoint.sh", entrypoint)
        .replaceAll("/psc/dlc/bin/proutil", proutil)
        .replaceAll("/psc/wrk", path.join(root, "work"))
        .replaceAll("/reports", path.join(root, "reports"));
      const command = service.command.map((s: string) =>
        s
          .replaceAll("/psc/dlc/bin/proutil", proutil)
          .replaceAll("/psc/wrk", path.join(root, "work"))
      );
      const child = spawn("/bin/sh", ["-c", script, "report", ...command], {
        env: {
          ...process.env,
          DB_NAME: "db",
          TEST_ROOT: root,
          TEST_MODE: mode,
          PATH: root + path.delimiter + process.env.PATH
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      const result = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        if (mode.startsWith("cancel-")) {
          const marker = mode === "cancel-startup" ? "started" : "analyzing";
          const deadline = Date.now() + 4000;
          while (!fs.existsSync(path.join(root, marker))) {
            if (Date.now() > deadline) throw new Error("fixture_start_timeout:" + stderr);
            await new Promise((r) => setTimeout(r, 5));
          }
          child.kill("SIGTERM");
        }
        const status = await result;
        assert.equal(
          status,
          mode.startsWith("cancel-")
            ? 143
            : mode === "native-error"
              ? 17
              : mode === "startup-error"
                ? 52
                : 0,
          stderr
        );
        if (mode === "startup-error") {
          assert.match(stderr, /report_database_start_failed/);
          assert.equal(fs.existsSync(path.join(root, "analyzing")), false);
        } else {
          assert.ok(fs.existsSync(path.join(root, "stopped")), stderr);
        }
        if (mode === "cancel-startup")
          assert.equal(fs.existsSync(path.join(root, "analyzing")), false);
        if (mode === "cancel-analysis")
          assert.ok(fs.existsSync(path.join(root, "analysis-stopped")));
        if (mode === "success" || mode === "native-error")
          assert.equal(
            fs.readFileSync(path.join(root, "reports/raw/report.table.txt"), "utf8"),
            "native-output\n"
          );
      } finally {
        clearTimeout(watchdog);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
