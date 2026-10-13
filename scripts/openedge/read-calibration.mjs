import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const Ajv = require("ajv");
export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/contracts/src/schemas/read-calibration-v1.schema.json"), "utf8"));
const schemaValid = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",")}}`;
  return JSON.stringify(value);
}
export const canonicalHash = value => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
export function readProfile() {
  const profile = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "scripts/openedge/benchmark-read-profile.json"), "utf8"));
  validateReadProfile(profile); return profile;
}
export function validateReadProfile(profile) {
  if (profile.version !== "parkbench-read-profile.v1" || profile.operations?.length !== 16 || new Set(profile.operations.map(o => o.id)).size !== 16 || profile.operations.reduce((s,o) => s + o.weight, 0) !== 74) throw new Error("read_profile_operations_invalid");
  const inventory = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "scripts/openedge/table-write-inventory.json"), "utf8"));
  const union = new Map();
  for (const op of profile.operations) {
    if (!Number.isFinite(op.weight) || op.weight <= 0) throw new Error("read_profile_weight_invalid");
    const input = op.bodyTemplate.input, table = inventory.tables.find(t => t.name === input.TableName);
    if (!table || op.bodyTemplate.procName !== "Workloads/Generic/arbitrary_reads.p") throw new Error("read_profile_table_invalid");
    for (const name of [...(input.FieldsList ?? []), ...(input.LobFields ?? [])]) if (!table.fields.some(f => f.name === name)) throw new Error("read_profile_field_invalid:" + name);
    for (const name of input.LobFields ?? []) if (!table.fields.find(f => f.name === name)?.lob) throw new Error("read_profile_lob_invalid:" + name);
    const fields = union.get(table.name) ?? new Set(); (input.LobFields ?? []).forEach(n => fields.add(n)); union.set(table.name, fields);
  }
  const expected = [...union].sort(([a],[b]) => a.localeCompare(b)).map(([name, fields]) => ({ name, requestedLobFields: [...fields].sort() }));
  if (canonicalJson(profile.tables) !== canonicalJson(expected)) throw new Error("read_profile_union_invalid");
  if (profile.partitionMap) {
    if (profile.partitionMap.length !== 16 || new Set(profile.partitionMap.map(p => p.operationId)).size !== 16) throw new Error("read_partition_operations_invalid");
    for (const entry of profile.partitionMap) {
      const op = profile.operations.find(o => o.id === entry.operationId);
      const table = inventory.tables.find(t => t.name === op?.bodyTemplate.input.TableName);
      // The current schema uses one numeric unique primary key per table. Reject
      // unsupported tuples rather than silently applying JS string ordering.
      const nativeType = table?.fields.find(field => field.name === table.primaryField)?.type.toUpperCase();
      if (!table || canonicalJson(entry.keyFields) !== canonicalJson([table.primaryField]) || !["INTEGER", "INT64"].includes(entry.keyTypes?.[0]) || entry.keyTypes.length !== 1 || entry.keyTypes[0] !== nativeType) throw new Error("read_partition_key_unsupported");
      if (!Array.isArray(entry.ranges) || !entry.ranges.length || entry.ranges[0].lowerInclusive !== null || entry.ranges.at(-1).upperExclusive !== null) throw new Error("read_partition_domain_incomplete");
      for (let i = 0; i < entry.ranges.length; i++) {
        const r = entry.ranges[i];
        for (const bound of [r.lowerInclusive, r.upperExclusive]) if (bound !== null && (!Array.isArray(bound) || bound.length !== 1 || !Number.isSafeInteger(bound[0]))) throw new Error("read_partition_bound_invalid");
        if (r.lowerInclusive !== null && r.upperExclusive !== null && r.lowerInclusive[0] >= r.upperExclusive[0]) throw new Error("read_partition_empty_or_reversed");
        if (i && (r.lowerInclusive === null || canonicalJson(entry.ranges[i-1].upperExclusive) !== canonicalJson(r.lowerInclusive))) throw new Error("read_partition_gap_or_overlap");
        if (i < entry.ranges.length - 1 && r.upperExclusive === null) throw new Error("read_partition_overlap");
      }
    }
  }
  return profile;
}
function sum(values) { let total = 0; for (const v of values) { total += v; if (!Number.isSafeInteger(total)) throw new Error("read_calibration_size_overflow"); } return total; }
function histogram(h) {
  const map = new Map();
  for (const b of h) { if (map.has(b.bucket) || b.totalBytes !== sum([b.recordBytes,b.lobBytes])) throw new Error("read_calibration_bucket_invalid"); map.set(b.bucket,b); }
  if (map.size !== 1000 || Array.from({length:1000},(_,i)=>i+1).some(i=>!map.has(i))) throw new Error("read_calibration_bucket_set_invalid");
  return Array.from({length:1000},(_,i)=>map.get(i+1));
}
function validTimestamp(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match || !Number.isFinite(Date.parse(text))) return false;
  const [y,m,d,h,min,s] = match.slice(1).map(Number), day = new Date(Date.UTC(y,m-1,d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m-1 && day.getUTCDate() === d && h < 24 && min < 60 && s < 60;
}
export function validateCalibration(report, expected = {}) {
  if (!schemaValid(report)) throw new Error("read_calibration_schema_invalid:" + JSON.stringify(schemaValid.errors));
  if (!validTimestamp(report.measuredAt)) throw new Error("read_calibration_timestamp_invalid");
  const global = histogram(report.buckets), tables = report.tables.map(t => histogram(t.buckets));
  if (new Set(report.tables.map(t=>t.name)).size !== report.tables.length) throw new Error("read_calibration_duplicate_table");
  for (let i=0;i<1000;i++) for (const field of ["rowCount","recordBytes","lobBytes","totalBytes"]) if (global[i][field] !== sum(tables.map(t=>t[i][field]))) throw new Error("read_calibration_table_sum_invalid");
  const total = sum(global.map(b=>b.totalBytes)), selected = sum(global.slice(0,report.cutoffN).map(b=>b.totalBytes)), previous = sum(global.slice(0,report.cutoffN-1).map(b=>b.totalBytes));
  if (total !== report.totalEligibleBytes || selected !== report.selectedEligibleBytes || selected !== report.verification.selectedBytes || previous !== report.verification.previousCutoffBytes) throw new Error("read_calibration_verification_mismatch");
  if (report.status === "calibrated" && (selected < report.targetBytes || previous >= report.targetBytes || selected-report.targetBytes >= global[report.cutoffN-1].totalBytes)) throw new Error("read_calibration_minimum_cutoff_invalid");
  if (report.status === "undersized" && (total >= report.targetBytes || report.cutoffN !== 1000)) throw new Error("read_calibration_undersized_invalid");
  const profile = expected.profile;
  if (profile) {
    validateReadProfile(profile);
    expected = { ...expected, readProfileHash: canonicalHash(profile) };
    const actual = report.tables.map(t=>({name:t.name,requestedLobFields:[...t.requestedLobFields].sort()})).sort((a,b)=>a.name.localeCompare(b.name));
    if (canonicalJson(actual) !== canonicalJson(profile.tables)) throw new Error("read_calibration_profile_union_mismatch");
    if (profile.partitionMap) {
      if (report.accessCoverage?.mode !== "primary-key-partitioned" || report.accessCoverage.partitionMapHash !== canonicalHash(profile.partitionMap)) throw new Error("read_calibration_partition_coverage_mismatch");
    } else if (report.accessCoverage?.mode === "primary-key-partitioned") throw new Error("read_calibration_unexpected_partition");
  }
  for (const key of ["schemaHash","readProfileHash"]) if (expected[key] && report[key] !== expected[key]) throw new Error("read_calibration_stale:" + key);
  if (expected.seedFingerprint && report.seed.fingerprint !== expected.seedFingerprint) throw new Error("read_calibration_stale:seedFingerprint");
  return report;
}
export async function hashFile(filename) {
  const hash = crypto.createHash("sha256"); for await (const chunk of fs.createReadStream(filename)) hash.update(chunk); return hash.digest("hex");
}
export async function fingerprintSeed(directory) {
  const entries = fs.readdirSync(directory, {withFileTypes:true}).filter(e=>/\.(?:db|d\d+|st)$/.test(e.name)).sort((a,b)=>a.name.localeCompare(b.name));
  if (!entries.some(e=>e.name.endsWith(".st")) || !entries.some(e=>/\.d\d+$/.test(e.name))) throw new Error("read_seed_identity_missing_files");
  const manifest = [];
  for (const entry of entries) { if (!entry.isFile() || fs.lstatSync(path.join(directory,entry.name)).isSymbolicLink()) throw new Error("read_seed_identity_invalid_file"); manifest.push({path:entry.name,sha256:await hashFile(path.join(directory,entry.name))}); }
  return canonicalHash(manifest);
}
export function compareCalibrationIdentity(report, observed) {
  const expected = { seedFingerprint:report.seed.fingerprint, schemaHash:report.schemaHash, readProfileHash:report.readProfileHash };
  if (report.accessCoverage?.partitionMapHash) expected.partitionMapHash=report.accessCoverage.partitionMapHash;
  if (Object.keys(expected).some(k=>!(/^[a-f0-9]{64}$/).test(observed[k]??""))) return {state:"unverified",reason:"identity_inspection_incomplete"};
  const mismatched = Object.keys(expected).filter(k=>expected[k]!==observed[k]);
  return mismatched.length ? {state:"stale",mismatched} : {state:"verified"};
}
export function atomicPublishCalibration(filename, report, expected = {}) {
  validateCalibration(report, expected); fs.mkdirSync(path.dirname(filename),{recursive:true});
  const temporary = filename + "." + crypto.randomUUID() + ".tmp";
  try { const fd=fs.openSync(temporary,"wx"); try {fs.writeFileSync(fd,JSON.stringify(report,null,2)+"\n");fs.fsyncSync(fd);} finally {fs.closeSync(fd);} fs.renameSync(temporary,filename); }
  finally {fs.rmSync(temporary,{force:true});}
}
