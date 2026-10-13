import fs from "node:fs";
import zlib from "node:zlib";
import { Scenario } from "../../../../packages/contracts/src/scenario";

export interface ArchiveContents {
  contractVersion: "archive-contents.v1";
  state: "COMPLETE" | "PARTIAL";
  included: string[];
  excluded: Array<{ procedure: string; reasonCode?: string }>;
}

/** Read ZIP central directories, including older archives without a manifest. */
function zipEntries(bytes: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let cursor = bytes.length - 22; cursor >= Math.max(0, bytes.length - 65557); cursor--) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50) { end = cursor; break; }
  }
  if (end < 0) throw new Error("archive_zip_invalid");
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const result = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("archive_zip_invalid");
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (!name || name.startsWith("/") || name.split("/").includes("..") || result.has(name))
      throw new Error("archive_zip_invalid");
    if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50)
      throw new Error("archive_zip_invalid");
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const localExtraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLength + localExtraLength;
    if (start + compressed > bytes.length) throw new Error("archive_zip_invalid");
    const data = bytes.subarray(start, start + compressed);
    result.set(name, method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) :
      (() => { throw new Error("archive_zip_method_unsupported"); })());
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

export function readArchiveContents(file: string): ArchiveContents {
  let outer: Map<string, Buffer>;
  try { outer = zipEntries(fs.readFileSync(file)); }
  catch (error) { throw new Error(`archive_unverifiable:${String(error)}`); }
  const nested = outer.get("ablapps/parkbench.zip");
  if (!nested) throw new Error("archive_nested_app_missing");
  const inner = zipEntries(nested);
  const actual = [...inner.keys()].filter((name) => /^openedge\/Workloads\/.+\.r$/.test(name))
    .map((name) => name.slice("openedge/".length)).sort();
  const manifestBytes = inner.get("parkbench/archive-contents.json");
  if (!manifestBytes) return { contractVersion: "archive-contents.v1", state: "COMPLETE",
    included: actual, excluded: [] };
  let manifest: ArchiveContents;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")) as ArchiveContents; }
  catch { throw new Error("archive_manifest_invalid"); }
  if (manifest.contractVersion !== "archive-contents.v1" ||
    !["COMPLETE", "PARTIAL"].includes(manifest.state) ||
    !Array.isArray(manifest.included) || !Array.isArray(manifest.excluded) ||
    manifest.included.some((name) => typeof name !== "string" || !actual.includes(name)) ||
    new Set(manifest.included).size !== manifest.included.length ||
    manifest.included.length !== actual.length ||
    manifest.excluded.some((item) => !item || typeof item.procedure !== "string" || actual.includes(item.procedure)) ||
    (manifest.state === "PARTIAL" && (!manifest.included.length || !manifest.excluded.length)) ||
    (manifest.state === "COMPLETE" && manifest.excluded.length))
    throw new Error("archive_manifest_invalid");
  return manifest;
}

export function requiredScenarioProcedures(scenario: Scenario): string[] {
  return [...new Set(scenario.workload.operations.flatMap((operation) => {
    const name = (operation.bodyTemplate as any)?.procName;
    return typeof name === "string" ? [name.replace(/\.p$/, ".r")] : [];
  }))];
}

export function assertScenarioArchiveCompatible(file: string, scenario: Scenario): ArchiveContents {
  const contents = readArchiveContents(file);
  for (const procedure of requiredScenarioProcedures(scenario)) {
    if (!contents.included.includes(procedure))
      throw new Error(`archive_workload_excluded:${procedure}`);
  }
  return contents;
}
