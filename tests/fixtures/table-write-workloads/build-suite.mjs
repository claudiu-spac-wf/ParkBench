import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { repositoryRoot } from "../../../scripts/openedge/generate-write-workloads.mjs";
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export async function run({ fixture, inventory, report }) {
  const manifestPath = path.join(repositoryRoot, ".parkbench/openedge/manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.imageStage, "final");
  assert.equal(manifest.parkBenchReady, true);
  const writes = manifest.workloads.filter((w) => w.procName.startsWith("Workloads/Write/"));
  assert.equal(writes.length, 32);
  assert.ok(writes.every((w) => w.compiled && w.contract));
  const archivePath = path.join(repositoryRoot, ".parkbench/openedge", manifest.runnerArchive.path);
  // Verify the actual nested archive, including r-code and contract entries.
  execFileSync("python3", [
    "-c",
    `import zipfile,io,json,sys
z=zipfile.ZipFile(sys.argv[1])
n=[n for n in z.namelist() if n.endswith('ablapps/parkbench.zip')][0]
w=zipfile.ZipFile(io.BytesIO(z.read(n)))
for t in json.load(open(sys.argv[2]))['tables']:
 for ext in ['.p','.r','.contract.json']:
  assert 'openedge/Workloads/Write/'+t['name']+ext in w.namelist()
`,
    archivePath,
    path.join(repositoryRoot, "scripts/openedge/table-write-inventory.json")
  ]);
  report.manifestHash = sha256(manifestPath);
  report.archiveHash = sha256(archivePath);
  report.cases.push({ id: "final-image-all-32-compiled-and-packaged", ok: true, tables: 32 });
  fixture.compileDrivers(["prepare", "verify"]);
  fixture.prepareEmpty({ count: 100 });
  report.pas = await fixture.startPas();
  const before = fixture.snapshotAll();
  for (const table of inventory.tables) {
    const response = await fixture.request(table.name, { mode: "validate" });
    assert.equal(response.status, 200, table.name + ":readiness");
    report.cases.push({ id: table.name + ":read-only-readiness", ok: true, status: 200 });
  }
  assert.deepEqual(fixture.snapshotAll(), before);
  return report.cases;
}
