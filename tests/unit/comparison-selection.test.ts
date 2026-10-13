import { it } from "node:test";
import assert from "node:assert/strict";
import { candidateUnion, pageCandidates, changeBasket } from "../../apps/web/src/features/comparison/comparisonSelection";
import { DetailHydrator, restoreComparisonSelection } from "../../apps/web/src/features/comparison/comparisonApi";

it("keeps candidate discovery independent of explicit basket and baseline", () => {
  const experiments = [{id:"e1",runs:[{id:"a"},{id:"shared"}]},{id:"e2",runs:[{id:"b"},{id:"shared"}]}];
  assert.deepEqual(candidateUnion(experiments,["e1","e2"]).map(r=>r.id),["a","shared","b"]);
  const selected=changeBasket({baselineRunId:"a",variantRunIds:["b"]},{kind:"baseline",id:"b"});
  assert.deepEqual(selected,{baselineRunId:"b",variantRunIds:["a"]});
  const original=structuredClone(selected);
  pageCandidates(candidateUnion(experiments,[]),"",10);
  pageCandidates(candidateUnion(experiments,["e1"]),"nothing",0);
  assert.deepEqual(selected,original);
  assert.deepEqual(changeBasket(selected,{kind:"remove",id:"a"}),{baselineRunId:"b",variantRunIds:[]});
});
it("bounds candidate pages while filtering the whole union", () => {
  const runs=Array.from({length:130},(_,i)=>({id:`run-${i}`,experimentId:"e"}));
  assert.equal(pageCandidates(runs,"",0).items.length,50);
  assert.equal(pageCandidates(runs,"",2).items.length,30);
  assert.deepEqual(pageCandidates(runs,"run-129",0).items.map(r=>r.id),["run-129"]);
});
it("bounds hydration globally and ignores obsolete per-ID responses", async () => {
  let active=0,peak=0; const release:Record<string,()=>void>={}; const arrivals:string[]=[];
  const pool=new DetailHydrator(async(id:string)=>{active++;peak=Math.max(peak,active);await new Promise<void>(r=>{release[id]=r;});active--;return{id};});
  pool.setWanted(["a","b","c","d","e"],(id:string)=>arrivals.push(id));
  await new Promise(r=>setTimeout(r,0)); assert.equal(peak,4);
  pool.setWanted(["e"],(id:string)=>arrivals.push(id));
  for(const id of ["a","b","c","d"]) release[id]();
  await new Promise(r=>setTimeout(r,0)); release.e();
  await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(arrivals,["e"]);assert.equal(peak,4);pool.cancel();
});
it("restores every exact selection page and restarts an inconsistent revision", async () => {
  const ids=Array.from({length:130},(_,i)=>`run-${i}`);let revision=1,first=true;
  const result=()=>Promise.resolve({id:"cmp",selectionRevision:revision,baselineRunId:ids[0],runs:ids.slice(0,5)});
  const selection=async(_id:string,options:any)=>{
    if(options.cursor&&first){first=false;revision=2;throw Object.assign(new Error("stale"),{code:"comparison_selection_cursor_stale"});}
    return {selectionRevision:revision,selectionPage:{runIds:options.cursor?ids.slice(100):ids.slice(0,100),hasMore:!options.cursor,nextCursor:options.cursor?undefined:"next"}};
  };
  const restored=await restoreComparisonSelection("cmp",{result,selection});
  assert.equal(restored.comparison.selectionRevision,2);assert.deepEqual(restored.runIds,ids);
});
