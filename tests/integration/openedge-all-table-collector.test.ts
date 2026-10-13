import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseOpenEdgeDbObserverOutput } from "../../packages/observers/src/openedge-db/adapter";

it(
  "licensed native collector preserves all 70 supported tables and a busy table beyond 64",
  {
    skip: !process.env.PARKBENCH_RUN_OPENEDGE_TESTS,
    timeout: 180_000
  },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-all-table-"));
    const name = `parkbench-all-table-acceptance-${process.pid}`;
    const image = process.env.PARKBENCH_OPENEDGE_OBSERVER_IMAGE;
    assert.ok(image, "licensed observer image required");
    const docker = (...args: string[]) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 90_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });
    try {
      fs.writeFileSync(
        path.join(root, "fixture.df"),
        Array.from(
          { length: 70 },
          (_, i) =>
            `ADD TABLE "Table${String(i).padStart(4, "0")}"\n  AREA "Schema Area"\nADD FIELD "Id" OF "Table${String(i).padStart(4, "0")}" AS integer\n  FORMAT "->,>>>,>>9"\n  INITIAL "0"\n  POSITION 2\n  ORDER 10\n` +
            Array.from(
              { length: 5 },
              (_, j) =>
                `ADD INDEX "Index${String(i * 5 + j).padStart(4, "0")}" ON "Table${String(i).padStart(4, "0")}"\n  AREA "Schema Area"\n  INDEX-FIELD "Id" ASCENDING\n`
            ).join("")
        ).join("\n") + ".\n"
      );
      fs.writeFileSync(
        path.join(root, "load.p"),
        'RUN prodict/load_df.p (INPUT "/tmp/all-table/fixture.df").\nQUIT.\n'
      );
      fs.writeFileSync(
        path.join(root, "busy.p"),
        `DEFINE VARIABLE b AS HANDLE NO-UNDO.
CREATE BUFFER b FOR TABLE "Table0069".
DO TRANSACTION:
  DO i = 1 TO 100:
    b:BUFFER-CREATE().
    b:BUFFER-FIELD("Id"):BUFFER-VALUE = i.
    b:BUFFER-RELEASE().
  END.
END.
DELETE OBJECT b.
QUIT.
`.replace("CREATE BUFFER b", "DEFINE VARIABLE i AS INTEGER NO-UNDO.\nCREATE BUFFER b")
      );
      fs.writeFileSync(
        path.join(root, "rename.df"),
        'RENAME TABLE "Table0000" TO "Table0000Renamed"\n' +
          'RENAME INDEX "Index0000" TO "Index0000Renamed" ON "Table0000Renamed"\n.\n'
      );
      fs.writeFileSync(
        path.join(root, "rename.p"),
        'RUN prodict/load_df.p (INPUT "/tmp/all-table/rename.df").\nQUIT.\n'
      );
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "none",
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        "sleep 300"
      );
      docker("exec", name, "mkdir", "-p", "/tmp/all-table");
      docker("cp", root + "/.", name + ":/tmp/all-table");
      docker("exec", name, "chown", "-R", "node:node", "/tmp/all-table");
      const shell = (script: string) =>
        docker("exec", "--user", "node", "-e", "TERM=xterm", name, "sh", "-ec", script);
      shell(
        "cd /tmp/all-table; /psc/dlc/bin/prodb parkbench empty >/tmp/create.log 2>&1; /psc/dlc/bin/_progres -b -1 -db parkbench -p load.p >/tmp/load.log 2>&1; /psc/dlc/bin/_mprosrv parkbench -S 20931 -H 127.0.0.1 -tablerangesize 128 -indexrangesize 1024 >/tmp/broker.log 2>&1"
      );
      shell(
        "cd /tmp/all-table; /psc/dlc/bin/_progres -b -db parkbench -H 127.0.0.1 -S 20931 -p busy.p >/tmp/busy.log 2>&1"
      );
      const raw = docker(
        "exec",
        "-e",
        "DB_NAME=/tmp/all-table/parkbench",
        "-e",
        "DB_HOST=127.0.0.1",
        name,
        "/usr/local/bin/parkbench-openedge-db-observer"
      );
      const payload = parseOpenEdgeDbObserverOutput(raw);
      assert.equal(payload.protocolVersion, 3);
      assert.equal(payload.labels.indexes.length, 256);
      assert.deepEqual(
        payload.labels.indexes,
        Array.from(
          { length: 256 },
          (_, i) =>
            `Table${String(Math.floor(i / 5)).padStart(4, "0")}.Index${String(i).padStart(4, "0")}`
        )
      );
      assert.equal(payload.labels.tables.filter((name) => /^Table[0-9]{4}$/.test(name)).length, 70);
      const creates = payload.metrics.filter(
        (m) =>
          m.name === "table_operations_total" &&
          m.labels.operation === "create" &&
          m.labels.table !== undefined
      );
      assert.equal(creates.length, payload.labels.tables.length);
      assert.equal(creates.find((m) => m.labels.table === "Table0069")?.value, 100);
      assert.ok(creates.every((m) => m.labels.table !== "other"));
      // Change only this disposable database between two independent collector
      // processes. The collector must rebuild metadata, including original ownership.
      shell(
        "cd /tmp/all-table; /psc/dlc/bin/_progres -b -db parkbench -H 127.0.0.1 -S 20931 -p rename.p >/tmp/rename.log 2>&1"
      );
      const renamedRaw = docker(
        "exec",
        "-e",
        "DB_NAME=/tmp/all-table/parkbench",
        "-e",
        "DB_HOST=127.0.0.1",
        name,
        "/usr/local/bin/parkbench-openedge-db-observer"
      );
      const renamed = parseOpenEdgeDbObserverOutput(renamedRaw);
      assert.equal(renamed.protocolVersion, 3);
      assert.equal(renamed.labels.tables.length, payload.labels.tables.length);
      assert.ok(renamed.labels.tables.includes("Table0000Renamed"));
      assert.ok(!renamed.labels.tables.includes("Table0000"));
      assert.deepEqual(
        renamed.labels.indexes,
        payload.labels.indexes.map((label) =>
          label
            .replace(/^Table0000\./, "Table0000Renamed.")
            .replace(/\.Index0000$/, ".Index0000Renamed")
        )
      );
      assert.ok(renamed.metrics.some((m) => m.labels.table === "Table0000Renamed"));
      assert.ok(!renamed.metrics.some((m) => m.labels.table === "Table0000"));
      assert.ok(
        renamed.metrics.some((m) => m.labels.index === "Table0000Renamed.Index0000Renamed")
      );
      const evidenceRoot = process.env.PARKBENCH_OPENEDGE_METADATA_EVIDENCE_ROOT;
      if (evidenceRoot) {
        fs.mkdirSync(evidenceRoot, { recursive: true });
        fs.writeFileSync(
          path.join(evidenceRoot, "connected-metadata-rename.json"),
          JSON.stringify(
            {
              image,
              recordedAt: new Date().toISOString(),
              before: JSON.parse(raw),
              after: JSON.parse(renamedRaw)
            },
            null,
            2
          )
        );
      }
      console.log(
        JSON.stringify({
          protocolVersion: payload.protocolVersion,
          expectedFixtureTables: 70,
          nativeInventoryTables: payload.labels.tables.length,
          retainedTables: creates.length,
          busyTable: "Table0069",
          creates: 100,
          connectedDatabaseRename: "passed"
        })
      );
    } catch (error) {
      try {
        console.error(
          docker(
            "exec",
            name,
            "sh",
            "-c",
            "ls -ld /tmp/all-table; cat /tmp/create.log /tmp/load.log /tmp/broker.log /tmp/busy.log /tmp/rename.log 2>/dev/null; true"
          )
        );
      } catch {
        /* The failing setup may precede container creation. */
      }
      throw error;
    } finally {
      try {
        docker("rm", "-f", "-v", name);
      } catch {
        /* No container may have been created. */
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
