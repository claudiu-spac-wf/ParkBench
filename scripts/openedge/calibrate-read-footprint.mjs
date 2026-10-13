#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { NativeFixture } from "./test-write-workloads.mjs";
import { hostMemoryCheck } from "../host-preflight.mjs";
import { repositoryRoot, readProfile, canonicalHash, fingerprintSeed, validateCalibration, compareCalibrationIdentity, atomicPublishCalibration } from "./read-calibration.mjs";
const require = createRequire(import.meta.url);
const {loadEnvironment} = require("../lib/load-env.cjs");
export class ReadFixture extends NativeFixture {
  constructor(options) {
    // A scan needs bounded cache, not benchmark-sized cache. The ceiling covers
    // filesystem cache too, and never raises the operator's global DB limit.
    super({...options, databaseStartupWords:"-B=16384", memoryLimitBytes:2 * 1024 ** 3});
    this.name=this.name.replace("write-018", "read-019");
    this.memoryInfo = options.memoryInfo ?? (() => fs.readFileSync("/proc/meminfo", "utf8"));
  }
  async start() {
    const memory = hostMemoryCheck(this.memoryInfo());
    if (memory.status !== "pass") throw new Error("read_calibration_" + memory.diagnosticCode);
    return super.start();
  }
  compileReadProbes() {
    const sources = ["read-footprint", "verify-read-footprint"].map(n=>{
      fs.copyFileSync(path.join(repositoryRoot,"openedge/validation",n+".p"),path.join(this.root,n+".p")); return "/validation/"+n+".p";
    });
    this.compileSources(sources);
    fs.writeFileSync(path.join(this.root,"read-profile.json"),JSON.stringify(readProfile()));
  }
  probe(extra = {}, filename = "histogram.json") {
    return this.invoke("/validation/read-footprint.r",{profile:"/validation/read-profile.json",...extra,report:"/validation/"+filename},filename);
  }
  verify(cutoff) {
    return this.invoke("/validation/verify-read-footprint.r",{profile:"/validation/read-profile.json",cutoff,report:"/validation/bracket.json"},"bracket.json");
  }
  byteFixtures() {
    this.prepareEmpty({count:400});
    fs.writeFileSync(path.join(this.root,"empty.bin"),Buffer.alloc(0));
    const names=["prepare","verify"].map(n=>{
      fs.copyFileSync(path.join(repositoryRoot,"tests/fixtures/read-footprint/abl",n+".p"),path.join(this.root,"read-fixture-"+n+".p"));return "/validation/read-fixture-"+n+".p";
    });
    this.compileSources(names);
    this.invoke("/validation/read-fixture-prepare.r",{report:"/validation/read-prepare.json"},"read-prepare.json");
    const proof=this.invoke("/validation/read-fixture-verify.r",{report:"/validation/read-byte-proof.json"},"read-byte-proof.json");
    if (!proof.ok || proof.cases.length !== 6 || proof.extraDebitRecords !== 2501) throw new Error("read_byte_fixtures_incomplete");
    return proof;
  }
}
function aggregate(tables) {
  return Array.from({length:1000},(_,i)=>{
    const values = tables.map(t=>t.buckets[i]);
    const b = {bucket:i+1}; for (const key of ["rowCount","recordBytes","lobBytes","totalBytes"]) b[key]=values.reduce((s,v)=>s+v[key],0); return b;
  });
}
export async function calibrate(options, dependencies = {}) {
  const initializeEnvironment = dependencies.loadEnvironment ?? loadEnvironment;
  const createFixture = dependencies.createFixture ?? (input => new ReadFixture(input));
  initializeEnvironment({root:repositoryRoot,envFile:options.config,required:true});
  if (!options.seed || (!options.verifyOnly && !options.output) || (options.verifyOnly && !options.calibration)) throw new Error("read_calibration_arguments_required");
  const profile=readProfile();
  if (profile.partitionMap) throw new Error("read_partition_native_verification_required");
  let fixture, accepted, evidence={startedAt:new Date().toISOString(),mode:options.verifyOnly?"verify-only":"calibrate",state:"unverified"};
  try {
    const seedFingerprint=await fingerprintSeed(path.resolve(options.seed));
    evidence.seedFingerprint = seedFingerprint;
    fixture=createFixture({seed:path.resolve(options.seed)}); await fixture.start(); fixture.compileReadProbes();
    evidence.evidenceRoot=path.relative(repositoryRoot,fixture.root); evidence.imageId=fixture.imageId;
    const scan=fixture.probe(options.verifyOnly?{schemaOnly:true}:{});
    if (scan.ok !== true) throw new Error("read_native_probe_incomplete");
    const schemaHash=canonicalHash(scan.schema), readProfileHash=canonicalHash(profile);
    if (options.verifyOnly) {
      const report=validateCalibration(JSON.parse(fs.readFileSync(options.calibration,"utf8")));
      evidence={...evidence,...compareCalibrationIdentity(report,{seedFingerprint,schemaHash,readProfileHash})};
      if(evidence.state === "verified") validateCalibration(report,{profile});
      if (evidence.state !== "verified") throw new Error("read_calibration_"+evidence.state+":"+(evidence.mismatched?.join(",")??evidence.reason));
    } else {
      const buckets=aggregate(scan.tables), totalEligibleBytes=buckets.reduce((s,b)=>s+b.totalBytes,0);
      let selectedEligibleBytes=0, cutoffN=1000;
      for (const b of buckets) {selectedEligibleBytes+=b.totalBytes;if (selectedEligibleBytes>=9_000_000_000){cutoffN=b.bucket;break;}}
      const bracket=fixture.verify(cutoffN);
      if (bracket.ok!==true) throw new Error("read_native_bracket_incomplete");
      const byteProof=fixture.byteFixtures(); evidence.byteProof=byteProof;
      accepted={contractVersion:"parkbench-read-calibration.v1",measuredAt:new Date().toISOString(),measurementVersion:"native-read-footprint.v1",seed:{description:path.basename(path.resolve(options.seed)),fingerprint:seedFingerprint},schemaHash,readProfileHash,targetBytes:9_000_000_000,bucketCount:1000,cutoffN,status:totalEligibleBytes<9_000_000_000?"undersized":"calibrated",totalEligibleBytes,selectedEligibleBytes,buckets,tables:scan.tables,accessCoverage:{mode:"whole-bucket",verified:true},verification:{selectedBytes:bracket.selectedBytes,previousCutoffBytes:bracket.previousCutoffBytes,sourceUnchanged:true,byteAccountingVerified:true,probeVersion:"native-independent-bracket.v1"}};
      validateCalibration(accepted,{profile}); evidence.state="verified"; evidence.cutoffN=cutoffN; evidence.selectedEligibleBytes=selectedEligibleBytes;
    }
    if (await fingerprintSeed(path.resolve(options.seed))!==seedFingerprint) throw new Error("read_source_seed_changed");
    // Source check and owned resource cleanup must precede accepted publication.
    fixture.close(); fixture=undefined; evidence.sourceUnchanged=true; evidence.cleanup=true;
    if (accepted) atomicPublishCalibration(path.resolve(options.output),accepted,{profile});
    return {report:accepted,evidence};
  } catch (error) { evidence.error=error.message; if(evidence.state==="verified")evidence.state="unverified"; throw error; }
  finally {
    try {if(fixture){fixture.close();evidence.cleanup=true;}} catch(error){evidence.cleanup=false;evidence.cleanupError=error.message;}
    evidence.completedAt=new Date().toISOString();
    const dir=dependencies.evidenceDirectory ?? path.join(repositoryRoot,".parkbench/validation/feature019");fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,options.verifyOnly?"calibration-identity.json":"calibration.json"),JSON.stringify(evidence,null,2)+"\n");
  }
}
export function parseArgs(argv) {
  const options={}; for(let i=0;i<argv.length;i++) { const key=argv[i]; if(key==="--verify-only"){options.verifyOnly=true;continue;} if(!["--seed","--config","--output","--calibration"].includes(key)||!argv[i+1]||argv[i+1].startsWith("--"))throw new Error("read_calibration_arguments_invalid"); options[key.slice(2)]=argv[++i]; } return options;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const result=await calibrate(parseArgs(process.argv.slice(2)));console.log(JSON.stringify({state:result.evidence.state,cutoffN:result.report?.cutoffN,selectedEligibleBytes:result.report?.selectedEligibleBytes}));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
