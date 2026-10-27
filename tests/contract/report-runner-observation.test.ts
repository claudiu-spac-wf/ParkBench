import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DockerAnalysisRunner } from "../../packages/compose-runner/src/report-runner";
import { reportContainerName } from "../../packages/compose-runner/src/report-compose";
import { reportHarness, request } from "../fixtures/reports/harness";
test("failed healthy-container observations retry without stopping or releasing resources", async () => {
  const h = reportHarness();
  try {
    h.gate.pause();
    const report = h.service.create(request, "observer"),
      directory = h.artifacts.execution(report.id),
      token = "token";
    const resource: any = {
      reportId: report.id,
      token,
      directory,
      composeFile: directory + "/execution/compose.json",
      options: {
        reportId: report.id,
        token,
        directory,
        seedPath: report.seedSnapshot.path,
        databaseName: "db",
        image: "db:12.8.11",
        type: "DBANALYS",
        aliases: []
      }
    };
    const calls: string[][] = [];
    let closed = false,
      retries = 0;
    const runner = new DockerAnalysisRunner(
      async (args) => {
        calls.push(args);
        if (args[0] === "ps") throw new Error("docker_unreachable");
        return "";
      },
      async () => {
        if (++retries === 3) closed = true;
      }
    );
    await assert.rejects(
      runner.execute(report, resource, {
        cancelled: () => false,
        closed: () => closed,
        update: () => {}
      }),
      /controller_closed/
    );
    assert.equal(retries, 3);
    assert.equal(
      calls.some((a) => a[0] === "stop" || a[0] === "rm"),
      false
    );
  } finally {
    h.close();
  }
});
test("cleanup refuses a container whose ownership labels do not match", async () => {
  const h = reportHarness();
  try {
    h.gate.pause();
    const r = h.service.create(request, "ownership"),
      calls: string[][] = [];
    const runner = new DockerAnalysisRunner(async (args) => {
      calls.push(args);
      if (args[0] === "ps") return "foreign-id";
      if (args[0] === "inspect")
        return JSON.stringify([
          {
            Id: "foreign-id",
            Config: {
              Labels: {
                "parkbench.resource_kind": "report",
                "parkbench.report_id": "different",
                "parkbench.owner_token": "foreign"
              }
            },
            State: { Running: true }
          }
        ]);
      return "";
    });
    await assert.rejects(
      runner.cleanup({
        reportId: r.id,
        token: "owned",
        directory: h.root,
        composeFile: "unused",
        options: {} as any
      }),
      /ownership_invalid/
    );
    assert.equal(
      calls.some((a) => a[0] === "stop" || a[0] === "rm"),
      false
    );
  } finally {
    h.close();
  }
});
test("an uncertain create control call cannot release ownership on an absent-container observation", async () => {
  const h = reportHarness();
  try {
    h.gate.pause();
    const report = h.service.create(request, "uncertain-create"),
      directory = h.artifacts.execution(report.id);
    const resource: any = {
      reportId: report.id,
      token: "owned",
      directory,
      composeFile: directory + "/execution/compose.json",
      options: {
        reportId: report.id,
        token: "owned",
        directory,
        seedPath: report.seedSnapshot.path,
        databaseName: "db",
        image: "db:12.8.11",
        type: "DBANALYS",
        aliases: []
      }
    };
    const runner = new DockerAnalysisRunner(async (args) => {
      if (args[0] === "compose") throw new Error("report_docker_control_unavailable");
      return "";
    });
    await assert.rejects(
      runner.execute(report, resource, {
        cancelled: () => false,
        closed: () => false,
        update: () => {}
      }),
      /control_unavailable/
    );
    assert.equal(resource.creationUncertain, "version");
    await assert.rejects(runner.cleanup(resource), /cleanup_failed/);
  } finally {
    h.close();
  }
});

test("cleanup keeps the temporary copy until owned termination and preserves retained evidence", async () => {
  const h = reportHarness();
  try {
    h.gate.pause();
    const report = h.service.create(request, "copy-cleanup");
    const directory = h.artifacts.execution(report.id);
    const scratch = path.join(directory, "scratch");
    fs.writeFileSync(path.join(scratch, "db.db"), "temporary copy");
    fs.writeFileSync(path.join(directory, "raw", "report.table.txt"), "retained");
    const resource: any = {
      reportId: report.id,
      token: "owner",
      directory,
      composeFile: "unused",
      options: {}
    };
    let removed = false,
      failStop = true;
    const calls: string[] = [];
    const runner = new DockerAnalysisRunner(
      async (args) => {
        calls.push(args[0]);
        if (args[0] === "ps")
          return args.some((arg) => arg.endsWith("-analysis$")) && !removed ? "owned-id" : "";
        if (args[0] === "inspect")
          return JSON.stringify([
            {
              Id: "owned-id",
              Config: {
                Labels: {
                  "parkbench.resource_kind": "report",
                  "parkbench.report_id": report.id,
                  "parkbench.owner_token": "owner"
                }
              },
              State: { Running: failStop }
            }
          ]);
        if (args[0] === "stop") throw new Error("docker_unavailable");
        if (args[0] === "rm") {
          assert.ok(fs.existsSync(scratch));
          removed = true;
        }
        return "";
      },
      async () => {},
      async () => {
        fs.writeFileSync(
          path.join(directory, "execution", "analysis.log"),
          "cancelled diagnostics"
        );
      }
    );
    await assert.rejects(runner.cleanup(resource), /docker_unavailable/);
    assert.ok(fs.existsSync(scratch));
    assert.equal(calls.includes("rm"), false);
    failStop = false;
    await runner.cleanup(resource);
    assert.equal(fs.existsSync(scratch), false);
    assert.equal(
      fs.readFileSync(path.join(directory, "raw", "report.table.txt"), "utf8"),
      "retained"
    );
    assert.equal(
      fs.readFileSync(path.join(directory, "execution", "analysis.log"), "utf8"),
      "cancelled diagnostics"
    );
    await runner.cleanup(resource);
  } finally {
    h.close();
  }
});

for (const startupFailure of [false, true])
  test(`runner observes the combined database/report container, startup failure=${startupFailure}`, async () => {
    const h = reportHarness();
    try {
      h.gate.pause();
      const report = h.service.create(request, "combined-stage");
      const directory = h.artifacts.execution(report.id),
        token = "owner";
      const resource: any = {
        reportId: report.id,
        token,
        directory,
        composeFile: path.join(directory, "execution", "compose.json"),
        options: {
          reportId: report.id,
          token,
          directory,
          seedPath: report.seedSnapshot.path,
          databaseName: "db",
          image: "db:12.8.11",
          type: "DBANALYS",
          aliases: []
        }
      };
      const created: string[] = [];
      let current = "";
      const runner = new DockerAnalysisRunner(
        async (args) => {
          if (args[0] === "compose") {
            current = args.at(-1)!;
            created.push(current);
          }
          if (args[0] === "ps") return "owned-id";
          if (args[0] === "inspect")
            return JSON.stringify([
              {
                Id: "owned-id",
                Config: {
                  Labels: {
                    "parkbench.resource_kind": "report",
                    "parkbench.report_id": report.id,
                    "parkbench.owner_token": token
                  }
                },
                State: {
                  Status: "exited",
                  ExitCode: current === "analysis" && startupFailure ? 52 : 0
                }
              }
            ]);
          return "";
        },
        async () => {},
        async (_, stage) => {
          fs.writeFileSync(
            path.join(directory, "execution", stage + ".log"),
            stage === "version"
              ? "OpenEdge Release 12.8.11"
              : startupFailure
                ? "report_database_start_failed"
                : "analysis complete"
          );
        }
      );
      const callbacks = {
        cancelled: () => false,
        closed: () => false,
        update: (version: string, mounts: any[]) => {
          assert.equal(version, "12.8.11");
          assert.ok(mounts.some((m) => m.target === "/run/parkbench/seed/db" && m.readOnly));
          assert.ok(mounts.some((m) => m.target === "/psc/wrk" && !m.readOnly));
        }
      };
      if (startupFailure)
        await assert.rejects(
          runner.execute(report, resource, callbacks),
          /report_database_start_failed/
        );
      else await runner.execute(report, resource, callbacks);
      assert.deepEqual(created, ["version", "analysis"]);
      assert.equal(resource.stages.analysis.exitCode, startupFailure ? 52 : 0);
      assert.equal(fs.existsSync(path.join(directory, "execution", "recorded.st")), false);
    } finally {
      h.close();
    }
  });
