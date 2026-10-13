import { execFileSync } from "node:child_process";
import path from "node:path";

/** Stable control-plane entry point for the staged OpenEdge builder. */
export function runOpenEdgeBuild(argv = process.argv.slice(2)): void {
  execFileSync(process.execPath, [path.resolve("scripts/openedge/build-images.mjs"), ...argv], {
    stdio: "inherit"
  });
}

if (require.main === module) {
  try {
    runOpenEdgeBuild();
  } catch {
    process.exitCode = 1;
  }
}
