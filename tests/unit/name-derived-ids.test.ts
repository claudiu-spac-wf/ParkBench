import assert from "node:assert/strict";
import test from "node:test";
import { allocateNameDerivedId, scheduleSlug } from "../../apps/control-plane/src/runs/name-derived-id";

test("repeated schedule names allocate distinct recognizable four-hex IDs", () => {
  const used = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const id = allocateNameDerivedId("Buffer Sweep", (candidate) => used.has(candidate), () => 0);
    assert.match(id, /^buffer-sweep-[0-9a-f]{4}$/);
    assert.ok(!used.has(id));
    used.add(id);
  }
  assert.equal(used.size, 100);
});

test("collision checks include IDs created before this process", () => {
  const existing = new Set(["buffer-sweep-0000", "buffer-sweep-0001"]);
  assert.equal(allocateNameDerivedId("Buffer Sweep", (id) => existing.has(id), () => 0), "buffer-sweep-0002");
});

test("invalid names and exhausted suffixes fail without overwriting", () => {
  for (const name of ["", "////", "../run", "x".repeat(49)])
    assert.throws(() => scheduleSlug(name), /schedule_name_invalid/);
  assert.throws(() => allocateNameDerivedId("Buffer Sweep", () => true, () => 0), /name_suffix_exhausted/);
});

import {allocateNumberedRunId} from "../../apps/control-plane/src/runs/name-derived-id";
import {nextRunNames} from "../../apps/control-plane/src/runs/run-numbering";
test("numbered run IDs bind the displayed number before collision protection",()=>{
 assert.equal(allocateNumberedRunId("Buffer Sweep",12,id=>id==="buffer-sweep-12-ffff",()=>65535),"buffer-sweep-12-0000");
 for(const number of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>allocateNumberedRunId("Buffer Sweep",number,()=>false),/run_number_invalid/);
 assert.throws(()=>allocateNumberedRunId("Buffer Sweep",12,()=>true,()=>0),/name_suffix_exhausted/);
 assert.equal(allocateNameDerivedId("Buffer Sweep",()=>false,()=>0),"buffer-sweep-0000");
});
test("number discovery includes old display metadata and new canonical snapshots",()=>{
 const repositories={listAllRuns:()=>[{name:"run_buffer-sweep-4",environmentSnapshot:{}},{environmentSnapshot:{runNameBase:"buffer-sweep",runNumber:7}}],client:{db:{prepare:()=>({all:()=>[{snapshot:JSON.stringify({runName:"run_buffer-sweep-9"})}]})}}} as any;
 assert.deepEqual(nextRunNames(repositories,"buffer-sweep",2).map(r=>r.name),["run_buffer-sweep-10","run_buffer-sweep-11"]);
});
import {composeProjectName} from "../../packages/compose-runner/src/project-name";
test("long numbered IDs keep distinct bounded Compose namespaces",()=>{
 const first=allocateNumberedRunId("x".repeat(48),1,()=>false,()=>0),second=allocateNumberedRunId("x".repeat(48),2,()=>false,()=>0);
 assert.notEqual(composeProjectName(first),composeProjectName(second));assert.ok(composeProjectName(first).length<=58);
});
