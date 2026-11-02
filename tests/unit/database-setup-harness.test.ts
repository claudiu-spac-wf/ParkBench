import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { nativeSetupHarness } from "../fixtures/database-setup/native-harness";
test("native spies expose target CWD, delayed broker shutdown and attributed failure", async () => {
  const h = nativeSetupHarness();
  try {
    h.write("shutdown-delay", 100);
    h.command("proserve", ["fixture"]);
    const deadline = Date.now() + 3000;
    while (fs.readFileSync(path.join(h.control, "busy"), "utf8") !== "6" && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(fs.readFileSync(path.join(h.control, "busy"), "utf8"), "6");
    h.command("proutil", ["fixture", "-C", "idxbuild", "all"]);
    assert.equal(h.events().find((e) => e.command === "proutil").cwd, h.database);
    h.write("failure", 7);
    assert.throws(() => h.command("proutil", ["fixture", "-C", "idxcompact", "PUB.T.I"]));
    h.command("proshut", ["fixture", "-by"]);
    assert.notEqual(fs.readFileSync(path.join(h.control, "busy"), "utf8"), "0");
    while (fs.readFileSync(path.join(h.control, "busy"), "utf8") !== "0" && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(fs.readFileSync(path.join(h.control, "busy"), "utf8"), "0");
  } finally {
    h.close();
  }
});
