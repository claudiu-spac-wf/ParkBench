import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
test("script discovery includes readable nested shell files and rejects escape references", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-script-source-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-outside-"));
  try {
    fs.mkdirSync(path.join(root, "with spaces"));
    fs.writeFileSync(path.join(root, "with spaces", "prepare.sh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o644
    });
    fs.writeFileSync(path.join(outside, "escape.sh"), "private outside sentinel");
    fs.symlinkSync(path.join(outside, "escape.sh"), path.join(root, "escape.sh"));
    fs.writeFileSync(path.join(root, "ignored.txt"), "");
    let discover: any, resolve: any;
    try {
      ({
        discoverSetupScripts: discover,
        resolveSetupScript: resolve
      } = require("../../apps/control-plane/src/database-setup/scripts"));
    } catch {
      discover = () => ({ state: "EMPTY", items: [] });
      resolve = () => ({});
    }
    const result = discover(root);
    assert(
      result.items.some(
        (x: any) =>
          x.scriptRef === "input:scripts/with spaces/prepare.sh" && x.availability === "AVAILABLE"
      )
    );
    assert(!result.items.some((x: any) => x.scriptRef === "input:scripts/ignored.txt"));
    assert.throws(
      () => resolve(root, "input:scripts/escape.sh"),
      /database_setup_script_unavailable/
    );
    assert.throws(
      () => resolve(root, "input:scripts/../escape.sh"),
      /database_setup_script_unavailable/
    );
    assert.equal(discover(path.join(root, "missing")).state, "EMPTY");
    assert.equal(fs.statSync(path.join(root, "with spaces", "prepare.sh")).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
