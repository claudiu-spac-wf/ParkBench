import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const enabled = process.env.PARKBENCH_RUN_OPENEDGE_TESTS === "1";
const image = process.env.PARKBENCH_OPENEDGE_OBSERVER_IMAGE;

function docker(args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 65536,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function captureFixture(kind: "unknown" | "mixed" | "missing" | "absent") {
  assert.ok(image && !image.endsWith(":latest"));
  const response = await fetch(
    (process.env.PARKBENCH_CONTROL_UI_URL ?? "http://127.0.0.1:13002") + "/api/v1/queue"
  );
  assert.equal(response.ok, true);
  const queue = await response.json();
  assert.ok(!queue.items.length && !queue.activeExperiment && !queue.hasMore);
  const source = await fs.readFile("openedge/observers/db/parkbench-db-observer-v2.p", "utf8");
  const procedures = ["captureTrans", "addField", "emitJson"].map((name) => {
    const body = source.match(
      new RegExp("PROCEDURE " + name + ":[\\s\\S]*?\\nEND PROCEDURE\\.")
    )?.[0];
    assert.ok(body, "execute the actual production " + name);
    // ABL reserves leading underscores for system schema. Bind the actual procedure
    // to a legal public temp-table field; only this schema identifier is adapted.
    return body.replaceAll("_Trans-Duration", "durationValue");
  });
  const count = kind === "unknown" ? 4096 : 129;
  const program = [
    "USING Progress.Json.ObjectModel.JsonObject.",
    "USING Progress.Json.ObjectModel.JsonArray.",
    "&GLOBAL-DEFINE PB_HAS_TRANS " + (kind === "absent" ? "0" : "1"),
    ...[...source.matchAll(/^DEFINE STREAM [^\r\n]+\./gm)].map((match) => match[0]),
    "DEFINE TEMP-TABLE fixture NO-UNDO FIELD ordinal AS INTEGER FIELD " +
      (kind === "missing" ? "anotherField" : "durationValue") +
      " AS DECIMAL INITIAL ? INDEX position IS PRIMARY UNIQUE ordinal.",
    "DEFINE BUFFER bTrans FOR fixture.",
    "DEFINE VARIABLE idx AS INTEGER NO-UNDO.",
    "DEFINE VARIABLE rows AS JsonArray NO-UNDO.",
    "DEFINE VARIABLE existsFlag AS LOGICAL NO-UNDO.",
    "DEFINE VARIABLE cursorObject AS Progress.Lang.Object NO-UNDO.",
    "DEFINE VARIABLE objectCount AS INTEGER NO-UNDO.",
    "DEFINE VARIABLE rootObject AS JsonObject NO-UNDO.",
    "DO idx = 1 TO " + count + ":",
    "  CREATE fixture.",
    "  fixture.ordinal = idx.",
    ...(kind === "mixed"
      ? [
          "  IF idx MODULO 3 = 2 THEN fixture.durationValue = 0.",
          "  IF idx MODULO 3 = 0 THEN fixture.durationValue = idx / 10."
        ]
      : []),
    "END.",
    "RUN captureTrans(OUTPUT rows, OUTPUT existsFlag).",
    // Observe actual AVM resource retention, independently of source spelling or timing.
    "cursorObject = SESSION:FIRST-OBJECT.",
    "DO WHILE VALID-OBJECT(cursorObject):",
    "  IF TYPE-OF(cursorObject, JsonObject) THEN objectCount = objectCount + 1.",
    "  cursorObject = cursorObject:NEXT-SIBLING.",
    "END.",
    "rootObject = NEW JsonObject().",
    'rootObject:Add("rows", rows).',
    'rootObject:Add("sourceExists", existsFlag).',
    'rootObject:Add("retainedJsonObjects", objectCount).',
    "RUN emitJson(INPUT rootObject).",
    ...procedures
  ].join("\n");
  const owner = "f024-trans-" + randomUUID();
  const wrapper = String.raw`const fs=require('node:fs'),{execFileSync}=require('node:child_process');fs.writeFileSync('/tmp/fixture.p',Buffer.from(process.env.FIXTURE_SOURCE,'base64'));const output=execFileSync('/psc/dlc/bin/_progres',['-b','-p','/tmp/fixture.p'],{cwd:'/tmp',timeout:5000,killSignal:'SIGKILL',maxBuffer:8*1024*1024,encoding:'utf8'});console.log(output);`;
  try {
    return JSON.parse(
      docker([
        "run",
        "--rm",
        "--read-only",
        "--network",
        "none",
        "--tmpfs",
        "/tmp:rw,nodev,nosuid",
        "--workdir",
        "/tmp",
        "--label",
        "parkbench.validation=" + owner,
        "-e",
        "TERM=xterm",
        "-e",
        "FIXTURE_SOURCE=" + Buffer.from(program).toString("base64"),
        image,
        "node",
        "-e",
        wrapper
      ])
    );
  } finally {
    const ids = docker(["ps", "-aq", "--filter", "label=parkbench.validation=" + owner])
      .split(/\s+/)
      .filter(Boolean);
    for (const id of ids) {
      assert.match(id, /^[a-f0-9]{12,64}$/);
      assert.equal(
        docker(["inspect", "--format", '{{index .Config.Labels "parkbench.validation"}}', id]),
        owner
      );
      docker(["rm", "-f", id]);
    }
  }
}

test(
  "licensed native transaction capture retains all 4096 unknown slots with bounded empty-object retention",
  { skip: !enabled, timeout: 40000 },
  async () => {
    const result = await captureFixture("unknown");
    assert.equal(result.sourceExists, true);
    assert.deepEqual(
      result.rows,
      Array.from({ length: 4096 }, () => ({}))
    );
    assert.ok(
      result.retainedJsonObjects <= 16,
      "empty slots retained " + result.retainedJsonObjects + " native objects"
    );
  }
);

test(
  "licensed native transaction capture preserves order, unknowns, true zero and numeric durations beyond 64 rows",
  { skip: !enabled, timeout: 40000 },
  async () => {
    const result = await captureFixture("mixed");
    assert.equal(result.sourceExists, true);
    assert.deepEqual(
      result.rows,
      Array.from({ length: 129 }, (_, i) => {
        const ordinal = i + 1;
        return ordinal % 3 === 1 ? {} : { durationValue: ordinal % 3 === 2 ? 0 : ordinal / 10 };
      })
    );
  }
);

test(
  "licensed native transaction capture keeps rows when the duration field is absent",
  { skip: !enabled, timeout: 40000 },
  async () => {
    const result = await captureFixture("missing");
    assert.equal(result.sourceExists, true);
    assert.deepEqual(
      result.rows,
      Array.from({ length: 129 }, () => ({}))
    );
  }
);

test(
  "licensed native transaction capture reports an absent table without inventing rows",
  { skip: !enabled, timeout: 40000 },
  async () => {
    const result = await captureFixture("absent");
    assert.equal(result.sourceExists, false);
    assert.deepEqual(result.rows, []);
  }
);
