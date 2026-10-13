import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import settings from "../fixtures/environment-settings.json";

const root = process.cwd();
const requireFromTest = createRequire(__filename);
const { parseEnvFile } = requireFromTest(path.join(root, "scripts/lib/load-env.cjs")) as {
  parseEnvFile(file: string): { keys: string[] };
};

function documentedInventory(): Map<string, string[]> {
  const file = path.join(root, "docs/operator-configuration.md");
  const contents = fs.readFileSync(file, "utf8");
  const result = new Map<string, string[]>();
  for (const line of contents.split(/\r?\n/)) {
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim().replace(/^`|`$/g, ""));
    const key = cells[0];
    if (/^(?:PARKBENCH_[A-Z0-9_*]+|DOCKER_(?:CONTEXT|HOST))$/.test(key ?? ""))
      result.set(key, cells);
  }
  return result;
}

describe("operator environment setting inventory", () => {
  it("documents every example and workflow setting with complete consumer metadata", () => {
    const example = new Set(parseEnvFile(path.join(root, ".env.example")).keys);
    const documented = documentedInventory();
    const sourceKeys = new Set<string>();

    for (const relative of settings.sourceFiles) {
      const file = path.join(root, relative);
      assert.equal(fs.existsSync(file), true, `inventory source is missing: ${relative}`);
      const contents = fs.readFileSync(file, "utf8");
      for (const match of contents.matchAll(
        /\b(?:PARKBENCH_[A-Z0-9_]+|DOCKER_(?:CONTEXT|HOST))\b/g
      )) {
        const key = match[0].endsWith("_") ? `${match[0]}*` : match[0];
        sourceKeys.add(key);
      }
    }

    const expected = new Set([
      ...example,
      ...settings.workflowOnly,
      ...settings.ambientDocker,
      ...sourceKeys
    ]);
    for (const key of expected) {
      const cells = documented.get(key);
      assert.ok(cells, `${key} needs an operator configuration row`);
      assert.ok(cells!.length >= 6, `${key} needs default, source, scope, path base, and consumer`);
      assert.ok(cells!.slice(1, 6).every(Boolean), `${key} has incomplete setting metadata`);
    }

    for (const key of documented.keys())
      assert.ok(
        expected.has(key),
        `${key} is documented but absent from the environment inventory`
      );
  });
});
