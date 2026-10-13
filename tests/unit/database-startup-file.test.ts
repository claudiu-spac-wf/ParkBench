import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseStartupFile } from "../../packages/compose-runner/src/startup-file";

const cases = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), "tests/fixtures/database-parameters/startup-pf-cases.json"), "utf8"
)) as Record<string, { content: string | null; parameters?: Array<{ name: string; value: string }>; error?: string }>;

for (const [name, fixture] of Object.entries(cases)) {
  test(`startup.pf ${name}`, () => {
    if (fixture.error) {
      assert.throws(() => parseStartupFile(fixture.content), new RegExp(fixture.error));
      return;
    }
    const parsed = parseStartupFile(fixture.content);
    assert.deepEqual(parsed.parameters.map(({ name, value }) => ({ name, value })), fixture.parameters);
  });
}
