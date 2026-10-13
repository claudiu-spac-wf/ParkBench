import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("web proxy recovery", () => {
  it("resolves the control-plane service again after its container changes", () => {
    const config = fs.readFileSync(path.join(process.cwd(), "deploy/web/nginx.conf"), "utf8");
    const api = config.match(/location \/api\/ \{([\s\S]*?)\n  \}/)?.[1] ?? "";
    assert.match(api, /resolver 127\.0\.0\.11 valid=10s/);
    assert.match(api, /set \$control_plane_upstream control-plane:3000/);
    assert.match(api, /proxy_pass http:\/\/\$control_plane_upstream/);
  });
});
