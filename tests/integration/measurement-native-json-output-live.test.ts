import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const enabled = process.env.PARKBENCH_RUN_OPENEDGE_TESTS === "1";
const image = process.env.PARKBENCH_OPENEDGE_OBSERVER_IMAGE;
function docker(args: string[]) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    throw new Error("native_json_fixture_operation_failed");
  }
}
async function runEmitter(count: number, maxBuffer = 8 * 1024 * 1024) {
  assert.ok(image && /:[^/]+$/.test(image) && !image.endsWith(":latest"));
  const queue = await (
    await fetch(
      (process.env.PARKBENCH_CONTROL_UI_URL ?? "http://127.0.0.1:13002") + "/api/v1/queue"
    )
  ).json();
  assert.ok(
    !queue.items.length && !queue.activeExperiment,
    "native fixture requires an idle queue"
  );
  const source = await fs.readFile("openedge/observers/db/parkbench-db-observer-v2.p", "utf8");
  const emitter = source.match(/PROCEDURE emitJson:[\s\S]*?\nEND PROCEDURE\./)?.[0];
  assert.ok(emitter, "execute the actual production emitter");
  const streams = [...source.matchAll(/^DEFINE STREAM [^\r\n]+\./gm)]
    .map((match) => match[0])
    .join("\n");
  const program = `USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
${streams}
DEFINE VARIABLE fixtureRoot AS JsonObject NO-UNDO.
DEFINE VARIABLE fixtureRows AS JsonArray NO-UNDO.
DEFINE VARIABLE fixtureRow AS JsonObject NO-UNDO.
DEFINE VARIABLE fixtureIndex AS INTEGER NO-UNDO.
fixtureRoot = NEW JsonObject().
fixtureRows = NEW JsonArray().
DO fixtureIndex = 1 TO ${count}:
  fixtureRow = NEW JsonObject().
  fixtureRow:Add("id", fixtureIndex).
  fixtureRow:Add("text", FILL("x", 64)).
  fixtureRow:Add("reading", fixtureIndex).
  fixtureRow:Add("zero", 0).
  fixtureRows:Add(fixtureRow).
END.
fixtureRoot:Add("rows", fixtureRows).
fixtureRoot:Add("capturedAt", "2026-10-31T12:34:56.789Z").
fixtureRoot:Add("unicode", CHR(233)).
fixtureRoot:Add("quote", CHR(34)).
fixtureRoot:Add("backslash", CHR(92)).
fixtureRoot:Add("line", "left" + CHR(10) + "right").
RUN emitJson(INPUT fixtureRoot).
${emitter}
`;
  const owner = "f024-json-" + randomUUID();
  // The only injected content is this public fixture and the production source;
  // the licensed image has no DB/network/private mounts and writes only its tmpfs.
  const wrapper = String.raw`const fs=require('node:fs'),{promisify}=require('node:util'),{execFile}=require('node:child_process');(async()=>{fs.writeFileSync('/tmp/emission.p',Buffer.from(process.env.FIXTURE_SOURCE,'base64'),{mode:0o644});const startedAtMs=Date.now();let output='',error=null;try{output=(await promisify(execFile)('/psc/dlc/bin/_progres',['-b','-p','/tmp/emission.p'],{cwd:'/tmp',timeout:5000,killSignal:'SIGKILL',maxBuffer:Number(process.env.FIXTURE_MAX_BUFFER)})).stdout;}catch(e){output=e.stdout||'';error={errorCode:typeof e.code==='string'?e.code:null,exitCode:typeof e.code==='number'?e.code:null,signal:e.signal||null,killed:e.killed===true};}let shape=null;try{const p=JSON.parse(output.trim());shape={rows:p.rows.length,values:p.rows.every((r,i)=>r.id===i+1&&r.reading===i+1&&r.zero===0&&r.text==='x'.repeat(64)),capturedAt:p.capturedAt,unicode:p.unicode,quote:p.quote,backslash:p.backslash,line:p.line};}catch{}console.log(JSON.stringify({durationMs:Date.now()-startedAtMs,bytes:Buffer.byteLength(output),error,shape}));})().catch(()=>{console.log(JSON.stringify({wrapperFailure:true}));process.exitCode=2;});`;
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
        "-e",
        "FIXTURE_MAX_BUFFER=" + maxBuffer,

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
  "licensed native JSON emitter preserves zero, timestamp, Unicode and escaped identities",
  { skip: !enabled, timeout: 40000 },
  async () => {
    const result = await runEmitter(1600);
    assert.equal(result.error, null);
    assert.deepEqual(result.shape, {
      rows: 1600,
      values: true,
      capturedAt: "2026-10-31T12:34:56.789Z",
      unicode: "é",
      quote: '"',
      backslash: "\\",
      line: "left\nright"
    });
  }
);

test(
  "licensed native emitter finishes a complete frame below the existing8MiB bound within the unchanged5s child deadline",
  { skip: !enabled, timeout: 40000 },
  async () => {
    const result = await runEmitter(65536);
    assert.equal(result.error, null, JSON.stringify(result));
    assert.ok(result.bytes > 6 * 1024 * 1024 && result.bytes < 8 * 1024 * 1024);
    assert.equal(result.shape?.rows, 65536);
    assert.equal(result.shape?.values, true);
  }
);

test(
  "licensed native JSON output overflow remains rejected and cleans the buffered writer",
  { skip: !enabled, timeout: 40000 },
  async () => {
    const result = await runEmitter(1600, 1024);
    assert.equal(result.error?.errorCode, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    assert.equal(result.shape, null);
  }
);
