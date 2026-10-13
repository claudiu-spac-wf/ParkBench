import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const originalObserverSha256 = "b670c801085101207834ba55d090dc731082e19587347de2c4bbb4d86e812bbc";
export const sourceNames = ["_DbStatus", "_ActBuffer", "_ActSummary", "_TableStat", "_IndexStat", "_Checkpoint", "_ActPWs", "_ActBILog", "_Logging", "_ActIOType", "_ActLock", "_Latch", "_DbParams", "_Trans"] as const;
export type SourceName = typeof sourceNames[number];
export type FixtureValue = string | number | boolean | null;
/** Ordered rows, never a map keyed by a parameter name. A missing schema field
 * is different from a present field holding an ABL unknown value. */
export interface SourceFixture {
  present: boolean;
  fields: Record<string, "CHARACTER" | "DECIMAL" | "INTEGER" | "LOGICAL">;
  rows: Record<string, FixtureValue>[];
}
export interface ObserverFixtures {
  sources: Record<SourceName, SourceFixture>;
}
export function assertOriginalBaseline(source: string): void {
  assert.equal(createHash("sha256").update(source).digest("hex"), originalObserverSha256,
    "Original observer changed: reconcile the baseline before transformation");
}

/** Replace identifiers outside ABL strings and nested block comments. Preserve
 * JSON keys and original query text exactly; ~ is ABL's string escape. */
export function replaceAblIdentifiers(source: string, replacements: Record<string, string>): string {
  let result = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("/*", i)) {
      const start = i; i += 2; let depth = 1;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      assert.equal(depth, 0, "Unterminated ABL block comment");
      result += source.slice(start, i); continue;
    }
    if (source[i] === '"' || source[i] === "'") {
      const start = i; const quote = source[i++]; let closed = false;
      while (i < source.length) {
        if (source[i] === "~") { i += 2; continue; }
        if (source[i] === quote) {
          if (source[i + 1] === quote) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      assert.ok(closed, "Unterminated ABL string");
      result += source.slice(start, i); continue;
    }
    const token = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(i));
    if (token) { result += replacements[token[0]] ?? token[0]; i += token[0].length; }
    else result += source[i++];
  }
  return result;
}
function replaceExactlyOnce(source: string, anchor: string, replacement: string): string {
  assert.equal(source.split(anchor).length - 1, 1, `Expected one fixture anchor: ${anchor}`);
  return source.replace(anchor, replacement);
}
/** Exposed for the standalone transformation probe. Production-baseline
 * staging always checks the original SHA before calling this transformation. */
export function bindOriginalFixtureBuffers(source: string): string {
  source = replaceExactlyOnce(source, "CREATE BUFFER bufferHandle FOR TABLE sourceName NO-ERROR.",
    "RUN fixtureBuffer (INPUT sourceName, OUTPUT bufferHandle) NO-ERROR.");
  return replaceExactlyOnce(source, 'CREATE BUFFER databaseBuffer FOR TABLE "_DbParams" NO-ERROR.',
    'RUN fixtureBuffer (INPUT "_DbParams", OUTPUT databaseBuffer) NO-ERROR.');
}
export function stageObserverForFixtures(
  source: string,
  kind: "original" | "v2",
  fixturePrelude: string,
  fixtureDispatch: string,
  sourceBindings: Record<string, string>,
  metadataAssertions = ""
): string {
  if (kind === "original") {
    assertOriginalBaseline(source);
    source = bindOriginalFixtureBuffers(source);
  }
  const metadataBindings = {
    _File: "fixtureFile", _Index: "fixtureIndex",
    "_File-Number": "tableNumber", "_File-Name": "tableName", "_Tbl-Type": "tableType",
    "_idx-num": "indexNumber", "_Index-Name": "indexName", "_File-recid": "sourceFileRecid"
  };
  source = replaceAblIdentifiers(source, kind === "original" ? metadataBindings : { ...metadataBindings, ...sourceBindings });
  const using = /^(?:USING [^\r\n]+\.\r?\n)+/.exec(source);
  assert.ok(using, "Collector USING declarations missing");
  source = source.slice(0, using[0].length) + "\n" + fixturePrelude + "\n" + source.slice(using[0].length);
  if (kind === "v2" && metadataAssertions) {
    const guard = 'IF ERROR-STATUS:ERROR THEN RETURN ERROR "openedge_db_metadata_initialization_failed".';
    source = replaceExactlyOnce(source, guard, guard + "\n" + metadataAssertions);
  }
  return source + "\n" + fixtureDispatch + "\n";
}

export function withoutCollectionTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCollectionTimes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (["collectedAt", "attemptedAt", "capturedAt"].includes(key)) {
        assert.equal(typeof item, "string", "Collection timestamps retain their string type");
        return [key, "<collection timestamp>"];
      }
      return [key, withoutCollectionTimes(item)];
    }));
  }
  return value;
}
export function assertEquivalentOutputs(original: string, readable: string): void {
  assert.ok(original.endsWith("\n") && readable.endsWith("\n"), "JSON output must terminate with a newline");
  assert.deepEqual(withoutCollectionTimes(JSON.parse(readable)), withoutCollectionTimes(JSON.parse(original)));
}

export interface NativeFixtureSession {
  run(source: string, mode?: string, timeoutMs?: number): string;
  image: string;
  install(source: string, target: string): void;
  inspect(args: string[]): string;
}
/** Run only in a disposable owned container/database. docker cp avoids host
 * path remapping assumptions on Docker Desktop/WSL. No running run is altered. */
export function withNativeFixture<T>(action: (session: NativeFixtureSession) => T): T {
  const image = process.env.PARKBENCH_OPENEDGE_FIXTURE_IMAGE || process.env.PARKBENCH_OPENEDGE_OBSERVER_IMAGE || "parkbench/openedge-observer:dev";
  const command = process.env.PARKBENCH_OPENEDGE_DOCKER_COMMAND || "docker";
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-fixture-017-"));
  const container = `parkbench-fixture-017-${process.pid}-${Date.now()}`;
  let started = false; let sequence = 0;
  const docker = (...args: string[]) => execFileSync(command, args, {
    encoding: "utf8", timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    docker("run", "-d", "--pull=never", "--network", "none", "--name", container,
      "--entrypoint", "/bin/sh", image, "-c", "sleep 3600");
    started = true;
    docker("exec", container, "mkdir", "-p", "/tmp/feature017");
    docker("exec", container, "chown", "node:node", "/tmp/feature017");
    docker("exec", "--user", "node", container, "/bin/sh", "-ec",
      "cd /tmp/feature017; /psc/dlc/bin/prodb fixture empty >create.log 2>&1");
    return action({ image,
      inspect(args) { return docker("exec", "--user", "node", container, ...args); },
      install(source, target) {
        assert.ok(target.startsWith("/tmp/feature017/") || target.startsWith("/app/openedge/observers/db/"));
        const localAsset = path.join(local, "asset-" + (++sequence));
        fs.writeFileSync(localAsset, source);
        docker("cp", localAsset, `${container}:${target}`);
        docker("exec", container, "chown", "node:node", target);
      },
      run(source, mode = "", timeoutMs = 30_000) {
      const name = `case-${++sequence}.p`;
      const file = path.join(local, name); fs.writeFileSync(file, source);
      docker("cp", file, `${container}:/tmp/feature017/${name}`);
      docker("exec", container, "chown", "node:node", `/tmp/feature017/${name}`);
      const wrapper = path.join(local, "invoke.p");
      fs.writeFileSync(wrapper, `USING Progress.Json.ObjectModel.JsonObject.
DEFINE VARIABLE failure AS JsonObject NO-UNDO.
DEFINE VARIABLE errorText AS LONGCHAR NO-UNDO.
DEFINE VARIABLE errorChunk AS CHARACTER NO-UNDO.
RUN "/tmp/feature017/${name}" NO-ERROR.
IF RETURN-VALUE <> ? AND RETURN-VALUE <> "" THEN DO:
 failure = NEW JsonObject(). failure:Add("fixtureError", RETURN-VALUE).
 failure:Write(INPUT-OUTPUT errorText). errorChunk = STRING(errorText). PUT UNFORMATTED errorChunk SKIP.
END.
`);
      docker("cp", wrapper, `${container}:/tmp/feature017/invoke.p`);
      return execFileSync(command, ["exec", "--user", "node", "-e", "TERM=xterm", container,
        "/psc/dlc/bin/_progres", "-b", "-1", "-db", "/tmp/feature017/fixture",
        "-T", "/tmp/feature017", "-p", "/tmp/feature017/invoke.p", "-param", mode], {
        encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });
    }});
  } finally {
    if (started) { try { docker("rm", "-f", "-v", container); } catch { /* Preserve the primary failure. */ } }
    fs.rmSync(local, { recursive: true, force: true });
  }
}

export interface MetadataFixture {
  tables: { tableNumber: number; tableName: string; tableType: string }[];
  indexes: { indexNumber: number; indexName: string; ownerTableNumber: number }[];
  expectedTableLabels?: string[];
  expectedIndexLabels?: string[];
}
const ablLiteral = (value: FixtureValue): string => typeof value === "string" && value.length > 1000 && [...value].every(c => c === value[0])
  ? `FILL(${ablLiteral(value[0])}, ${value.length})` : value === null ? "?" : typeof value === "string"
  ? '"' + value.replace(/~/g, "~~").replace(/"/g, '~"').replace(/\n/g, "~n").replace(/\r/g, "~r") + '"'
  : typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
/** LIKE is confined to test VST bindings: it preserves native underscore field
 * schemas/types. Production metadata caches explicitly declare required fields. */
export function fixtureCollector(source: string, kind: "original" | "v2", fixtures: ObserverFixtures,
  metadata: MetadataFixture, missingFields: string[] = [], inspectMetadata = true): string {
  let declarations = `DEFINE TEMP-TABLE fixtureFile NO-UNDO
    FIELD tableNumber AS INTEGER FIELD tableName AS CHARACTER FIELD tableType AS CHARACTER
    INDEX tableNumber tableNumber INDEX names tableType tableName.
  DEFINE TEMP-TABLE fixtureIndex NO-UNDO
    FIELD indexNumber AS INTEGER FIELD indexName AS CHARACTER FIELD sourceFileRecid AS RECID
    INDEX indexNumber indexNumber INDEX owner sourceFileRecid indexName.
  DEFINE BUFFER ownerFixture FOR fixtureFile.\n`;
  let population = "";
  const bindings: Record<string, string> = {};
  let dispatch = `PROCEDURE fixtureBuffer:
    DEFINE INPUT PARAMETER sourceName AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER resultBuffer AS HANDLE NO-UNDO.
    CASE sourceName:\n`;
  if (kind === "v2") declarations += "&GLOBAL-DEFINE PB_HAS_BUFFSTATUS 0\n";
  for (const name of sourceNames) {
    const fixture = fixtures.sources[name];
    const table = "fixture" + name.slice(1);
    bindings[name] = table;
    if (fixture.present) {
      declarations += `DEFINE TEMP-TABLE ${table} NO-UNDO LIKE ${name}
        FIELD fixtureSequence AS INTEGER INDEX fixtureOrder IS PRIMARY fixtureSequence.\n`;
      fixture.rows.forEach((row, i) => {
        population += `CREATE ${table}.\n${table}.fixtureSequence = ${i + 1}.\n`;
        for (const [field, value] of Object.entries(row)) population += `  BUFFER ${table}:BUFFER-FIELD("${field}"):BUFFER-VALUE = ${ablLiteral(value)}.\n`;
        population += `RELEASE ${table}.\n`;
      });
      dispatch += `WHEN "${name}" THEN CREATE BUFFER resultBuffer FOR TABLE "${table}" BUFFER-NAME "${name}".\n`;
    } else if (kind === "v2") declarations += `&GLOBAL-DEFINE PB_HAS_${name.slice(1).toUpperCase()} 0\n`;
  }
  dispatch += "OTHERWISE RETURN ERROR \"fixture_source_absent\".\nEND CASE.\nEND PROCEDURE.\n";
  for (const row of metadata.tables) {
    population += `CREATE fixtureFile.\nASSIGN fixtureFile.tableNumber = ${row.tableNumber}
      fixtureFile.tableName = ${ablLiteral(row.tableName)} fixtureFile.tableType = ${ablLiteral(row.tableType)}.\nRELEASE fixtureFile.\n`;
  }
  for (const row of metadata.indexes) {
    population += `FIND FIRST ownerFixture WHERE ownerFixture.tableNumber = ${row.ownerTableNumber} NO-ERROR.
      CREATE fixtureIndex.\nASSIGN fixtureIndex.indexNumber = ${row.indexNumber}
      fixtureIndex.indexName = ${ablLiteral(row.indexName)}
      fixtureIndex.sourceFileRecid = ?.\nIF AVAILABLE ownerFixture THEN fixtureIndex.sourceFileRecid = RECID(ownerFixture).\nELSE fixtureIndex.sourceFileRecid = 999999.\nRELEASE fixtureIndex.\n`;
  }
  // Ensure copied RECIDs differ. Emptying an invocation-local table does not
  // reset its identity sequence; this is independent of the source row IDs.
  if (kind === "v2") population += "RUN fixtureAdvanceCopiedIdentity.\n";
  const copiedIdentity = `PROCEDURE fixtureAdvanceCopiedIdentity:
    DEFINE VARIABLE n AS INTEGER NO-UNDO.
    DO n = 1 TO 1000: CREATE ttFile. ttFile.sourceRecid = n. RELEASE ttFile. END.
    EMPTY TEMP-TABLE ttFile.
  END PROCEDURE.\n`;
  const checks = inspectMetadata ? `
  IF BUFFER ttFile:NUM-FIELDS <> 4 OR BUFFER ttIndex:NUM-FIELDS <> 3 THEN RETURN ERROR "fixture_cache_fields".
  FOR EACH fixtureFile:
    FIND FIRST ttFile WHERE ttFile.sourceRecid = RECID(fixtureFile) NO-ERROR.
    IF NOT AVAILABLE ttFile THEN RETURN ERROR "fixture_table_row_missing".
    IF ttFile.tableNumber <> fixtureFile.tableNumber OR ttFile.tableName <> fixtureFile.tableName OR
       ttFile.tableType <> fixtureFile.tableType OR RECID(ttFile) = RECID(fixtureFile) THEN RETURN ERROR "fixture_table_identity".
  END.
  FOR EACH fixtureIndex:
    FIND FIRST ttIndex WHERE ttIndex.indexNumber = fixtureIndex.indexNumber NO-ERROR.
    IF NOT AVAILABLE ttIndex THEN RETURN ERROR "fixture_index_row_missing".
    IF ttIndex.indexName <> fixtureIndex.indexName OR ttIndex.sourceFileRecid <> fixtureIndex.sourceFileRecid
       THEN RETURN ERROR "fixture_index_owner".
  END.\n` : "";
  let result = stageObserverForFixtures(source, kind, declarations + population,
    dispatch + (kind === "v2" ? copiedIdentity : ""), bindings, checks);
  // Test-only field capability simulation intercepts BUFFER-FIELD results,
  // preserving field names, query text, conversions, filters and failure checks.
  // VST fixtures otherwise inherit the matching native schema unchanged.
  if (missingFields.length) {
    const unavailable = missingFields.map(ablLiteral).join(",");
    result = result.replace(/(\s*fieldHandle = [^\n]*BUFFER-FIELD\([^\n]+ NO-ERROR\.)/g,
      `$1\n IF VALID-HANDLE(fieldHandle) THEN DO:\n IF CAN-DO(${ablLiteral(missingFields.join(","))}, fieldHandle:NAME) THEN fieldHandle = ?.\n END.`);
    assert.ok(unavailable.length > 0);
  }
  return result;
}
