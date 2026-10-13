import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("Grafana API proxy resolves its Docker service name at request time", () => {
  const config = readFileSync(path.resolve("deploy/web/nginx.conf"), "utf8");
  const grafanaLocation = config.match(/location \/grafana-api\/ \{([\s\S]*?)\n  \}/)?.[1];

  assert.ok(grafanaLocation, "Grafana API proxy location exists");
  assert.match(grafanaLocation, /resolver 127\.0\.0\.11/);
  assert.match(grafanaLocation, /set \$grafana_upstream grafana:3000;/);
  assert.match(grafanaLocation, /rewrite \^\/grafana-api\/\(\.\*\)\$ \/api\/\$1 break;/);
  assert.match(grafanaLocation, /proxy_pass http:\/\/\$grafana_upstream;/);
});
