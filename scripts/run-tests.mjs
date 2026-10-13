import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
require("./lib/load-env.cjs").loadEnvironment({
  root: fileURLToPath(new URL("..", import.meta.url))
});
const args = process.argv.slice(2);
const group = args.find(arg => !arg.startsWith("--"));
const testOptions = args.filter(arg => /^--test-concurrency=[1-9][0-9]*$/.test(arg));
if (args.some(arg => arg.startsWith("--") && !testOptions.includes(arg))) throw new Error("test_option_invalid");
const root = join(process.cwd(), "dist", "tests", group ?? "");
const files = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.name.endsWith(".test.js") || (group === "ui" && entry.name.endsWith(".spec.js")))
      files.push(file);
  }
}
visit(root);
if (!files.length) {
  console.error(`No test files found for group: ${group ?? "all"}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...testOptions, ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
