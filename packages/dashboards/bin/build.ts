import fs from "node:fs";
import path from "node:path";
import { generatedFiles, RETIRED_FILES, DASHBOARD_CATALOG } from "../src";

/**
 * Writes the generated dashboards and rules. With `--check`, exits non-zero if any
 * committed file differs from the builder output or a retired file still exists.
 */
const check = process.argv.includes("--check");
const root = process.cwd();
const files = generatedFiles({ webUrl: process.env.PARKBENCH_WEB_URL });
const problems: string[] = [];
for (const [relative, content] of Object.entries(files)) {
  const target = path.join(root, relative);
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
  if (current === content) continue;
  if (check) problems.push(`out of date: ${relative}`);
  else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    console.log(`wrote ${relative}`);
  }
}
for (const relative of RETIRED_FILES) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) continue;
  if (check) problems.push(`retired file still present: ${relative}`);
  else {
    fs.rmSync(target);
    console.log(`removed ${relative}`);
  }
}
if (check) {
  const managed = new Set(DASHBOARD_CATALOG.map((e) => e.uid));
  const seen = new Map<string, string>();
  const directory = path.join(root, "deploy/grafana/dashboards");
  for (const relative of fs.readdirSync(directory, { recursive: true }) as string[]) {
    if (!relative.endsWith(".json")) continue;
    const file = path.join(directory, relative);
    try {
      const document = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!managed.has(document.uid)) continue;
      if (seen.has(document.uid))
        problems.push(
          `duplicate managed UID: ${document.uid}: ${seen.get(document.uid)}, ${relative}`
        );
      seen.set(document.uid, relative);
      const entry = DASHBOARD_CATALOG.find((e) => e.uid === document.uid)!;
      if (relative.replaceAll(path.sep, "/") !== `${entry.folder}/${entry.file}`)
        problems.push(`incorrect managed folder: ${relative}`);
      if (document.title !== entry.title) problems.push(`incorrect managed title: ${relative}`);
    } catch (error) {
      problems.push(`invalid dashboard JSON: ${relative}: ${String(error)}`);
    }
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error("Run `npm run dashboards:build` to regenerate.");
  process.exit(1);
}
