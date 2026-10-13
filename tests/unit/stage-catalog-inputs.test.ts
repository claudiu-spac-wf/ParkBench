import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.join(process.cwd(), "scripts/openedge/stage-catalog-inputs.mjs")).href;
async function loadStage(): Promise<any> {
  const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
  return nativeImport(moduleUrl);
}

describe("licensed input catalog staging", () => {
  it("copies the runner archive into the persistent archives root; seeds need no staging", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-catalog-stage-"));
    try {
      const archive = path.join(temporary, "source-app");
      fs.writeFileSync(archive, "app bytes");
      const destination = path.join(temporary, "data");
      const { stageCatalogInputs } = await loadStage();
      const first = stageCatalogInputs({ dataRoot: destination, archivePath: archive });
      assert.deepEqual(first.map((item: any) => item.kind), ["archives"]);
      assert.deepEqual(stageCatalogInputs({ dataRoot: destination, archivePath: archive }), first);
      const files = fs.readdirSync(path.join(destination, "archives"));
      assert.deepEqual(files, ["parkbench-runner.zip"]);
      assert.equal(first[0].path, path.join(destination, "archives", "parkbench-runner.zip"));
      assert.equal(fs.statSync(first[0].path).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(path.join(destination, "seeds")), false);
      fs.writeFileSync(archive, "changed app bytes");
      stageCatalogInputs({ dataRoot: destination, archivePath: archive });
      assert.equal(fs.readFileSync(first[0].path, "utf8"), "changed app bytes");
      assert.throws(() => stageCatalogInputs({ dataRoot: destination }), /catalog_inputs_setting_required/);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
