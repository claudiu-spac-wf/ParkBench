import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertOriginalBaseline, sourceNames } from "../helpers/openedge-observer-equivalence";

const root = process.cwd();
const original: string = fs.readFileSync(path.join(root, "openedge/observers/db/parkbench-db-observer.p"), "utf8");
const readable: string = fs.readFileSync(path.join(root, "openedge/observers/db/parkbench-db-observer-v2.p"), "utf8");
const calls: RegExpMatchArray[] = Array.from(original.matchAll(/RUN captureSource\(INPUT "([^"]+)",\s*INPUT "([^"]+)"/g));
const procedure = (name: string) => {
  const match = new RegExp(`^PROCEDURE ${name}:([\\s\\S]*?)^END PROCEDURE\\.`, "m").exec(readable);
  assert.ok(match, `Missing dedicated procedure ${name}`);
  return match[1];
};
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ");

describe("Readable static OpenEdge collector", () => {
  it("retains the frozen original and all 104 explicit selected fields", () => {
    assertOriginalBaseline(original);
    assert.equal(calls.length, 14);
    assert.deepEqual(calls.map(c => c[1]), [...sourceNames]);
    assert.equal(calls.reduce((n, c) => n + c[2].split(",").length, 0), 104);
    for (const [, source, fieldNames] of calls) {
      const name = source.slice(1);
      const body = procedure(`capture${name}`);
      assert.match(withoutComments(body), new RegExp(`FOR EACH b${name} NO-LOCK`));
      assert.ok(body.includes(`&IF {&PB_HAS_${name.toUpperCase()}} = 1 &THEN`));
      assert.ok(readable.includes(`DEFINE BUFFER b${name} FOR ${source}.`));
      for (const field of fieldNames.split(",")) {
        const selected = new RegExp(`\\/\\*([^]*?)\\*\\/\\s*RUN addField\\(INPUT rowObject, INPUT BUFFER b${name}:HANDLE, INPUT "${field}"\\)\\.`).exec(body);
        assert.ok(selected, `Missing explicit field/comment ${source}.${field}`);
        const comment = selected[1].split("/*").at(-1)!;
        assert.ok(comment.trim().split(/\s+/).length >= 4, `Field name alone is not explanatory: ${field}`);
      }
      assert.ok(readable.includes(`RUN capture${name}(OUTPUT sourceArray, OUTPUT sourcePresent).`));
    }
  });
  it("has no dynamic queries or generic source dispatch in either mode", () => {
    const code = withoutComments(readable);
    assert.doesNotMatch(code, /CREATE\s+QUERY|QUERY-PREPARE|CREATE\s+BUFFER|captureSource|queryText/i);
    const full = procedure("captureParameterSnapshot");
    assert.match(full, /DEFINE QUERY parameterQuery FOR bDbParams/);
    assert.match(full, /OPEN QUERY parameterQuery FOR EACH bDbParams NO-LOCK/);
    assert.doesNotMatch(full, /CAN-DO/);
    const format = procedure("addField");
    assert.doesNotMatch(format, /FOR EACH|NUM-ENTRIES|CASE|sourceName/i);
  });
  it("declares seven required cache fields and reads database metadata only at startup", () => {
    assert.doesNotMatch(withoutComments(readable), /LIKE\s+_File|LIKE\s+_Index|BUFFER-COPY/i);
    const init = procedure("initializeMetadata");
    assert.match(init, /FOR EACH _File NO-LOCK/);
    assert.match(init, /FOR EACH _Index NO-LOCK/);
    assert.match(init, /ttFile\.sourceRecid = RECID\(_File\)/);
    assert.match(init, /ttIndex\.sourceFileRecid = _Index\._File-recid/);
    const outside = withoutComments(readable.replace(/^PROCEDURE initializeMetadata:[\s\S]*?^END PROCEDURE\./m, ""));
    assert.doesNotMatch(outside, /\b_File\b|\b_Index\b/);
    assert.match(procedure("loadLabelSets"), /ttIndex\.sourceFileRecid = ttFile\.sourceRecid/);
    assert.doesNotMatch(outside, /RECID\(ttFile\)/);
    assert.ok(readable.indexOf("RUN initializeMetadata") < readable.indexOf('IF SESSION:PARAMETER = "parameter-capture"'));
    assert.match(procedure("emitJson"), /SUBSTRING\(textToEmit, offsetToEmit, 30000\)/);
  });
});
