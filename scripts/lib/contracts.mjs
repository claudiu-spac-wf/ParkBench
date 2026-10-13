// Loads the TypeScript contract validators (packages/contracts) from build scripts without a
// prior `npm run build`, so scripts and the control plane share one set of rules.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let cached;

export function loadContracts() {
  if (!cached) {
    // Prefer the compiled modules (present after `npm run build`, which bootstrap runs first);
    // fall back to transpiling the TypeScript sources with tsx.
    const compiled = ["seed", "workload-contract", "openedge", "openedge-validation"].map((name) =>
      path.join(repoRoot, "dist/packages/contracts/src", `${name}.js`)
    );
    if (compiled.every((file) => fs.existsSync(file))) {
      cached = Object.assign({}, ...compiled.map((file) => require(file)));
      return cached;
    }
    const tsx = require("tsx/cjs/api");
    cached = {
      ...tsx.require(path.join(repoRoot, "packages/contracts/src/seed.ts"), import.meta.url),
      ...tsx.require(path.join(repoRoot, "packages/contracts/src/openedge.ts"), import.meta.url),
      ...tsx.require(
        path.join(repoRoot, "packages/contracts/src/openedge-validation.ts"),
        import.meta.url
      ),
      ...tsx.require(
        path.join(repoRoot, "packages/contracts/src/workload-contract.ts"),
        import.meta.url
      )
    };
  }
  return cached;
}
