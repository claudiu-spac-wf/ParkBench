import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createSeedFixture } from "./seed";

export const readinessEvidenceRoot = path.resolve(".parkbench/validation/feature019");
export function readReadinessFixture<T = any>(name: "native-series" | "run-windows" | "comparisons"): T {
  return JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/benchmark-readiness", `${name}.json`), "utf8"));
}
export function recordReadinessEvidence(name: string, evidence: unknown): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("invalid_readiness_evidence_name");
  fs.mkdirSync(readinessEvidenceRoot, { recursive: true });
  const filename = path.join(readinessEvidenceRoot, `${name}.json`);
  fs.writeFileSync(filename, JSON.stringify(evidence, null, 2) + "\n");
  return filename;
}
export function fixtureFingerprint(filename: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}
export function createReadinessSeed(root: string, name = "readiness_fixture"): string {
  return createSeedFixture(root, name);
}
export function cleanupReadinessFixture(ownedRoot: string, temporaryParent: string): void {
  const relative = path.relative(path.resolve(temporaryParent), path.resolve(ownedRoot));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("readiness_cleanup_outside_owned_root");
  fs.rmSync(ownedRoot, { recursive: true, force: true });
}
