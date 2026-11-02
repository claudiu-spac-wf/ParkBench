import fs from "node:fs";
import path from "node:path";
import {
  SetupScriptEntry,
  SetupScriptsDiscovery
} from "../../../../packages/contracts/src/database-setup";
const inside = (candidate: string, root: string) =>
  candidate === root || candidate.startsWith(root + path.sep);
export function scriptsRoot(configured?: string) {
  return path.resolve(
    configured ?? process.env.PARKBENCH_DISCOVERY_SCRIPTS_ROOT ?? ".parkbench/scripts"
  );
}
export function resolveSetupScript(
  configured: string | undefined,
  reference: string
): { sourcePath: string; relativePath: string; root: string } {
  try {
    if (!reference.startsWith("input:scripts/")) throw new Error("reference");
    const relativePath = reference.slice("input:scripts/".length);
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).includes("..") ||
      !relativePath.endsWith(".sh")
    )
      throw new Error("reference");
    const root = fs.realpathSync(scriptsRoot(configured)),
      sourcePath = fs.realpathSync(path.resolve(root, relativePath));
    if (!inside(sourcePath, root) || !fs.statSync(sourcePath).isFile())
      throw new Error("containment_or_kind");
    fs.accessSync(sourcePath, fs.constants.R_OK);
    return { sourcePath, relativePath, root };
  } catch (error) {
    throw new Error(`database_setup_script_unavailable:${reference}:${(error as Error).message}`);
  }
}
export function discoverSetupScripts(configured?: string): SetupScriptsDiscovery {
  const result: SetupScriptsDiscovery = {
    contractVersion: "database-setup-scripts.v1",
    state: "EMPTY",
    discoveredAt: new Date().toISOString(),
    items: []
  };
  const root = scriptsRoot(configured);
  try {
    fs.statSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    result.state = "FAILED";
    result.reason = String(error);
    return result;
  }
  try {
    const realRoot = fs.realpathSync(root);
    let visited = 0,
      degraded = false;
    const walk = (directory: string, relative: string, parents: Set<string>, depth: number) => {
      if (depth > 32 || visited > 10000) {
        degraded = true;
        return;
      }
      const real = fs.realpathSync(directory);
      if (!inside(real, realRoot) || parents.has(real)) {
        degraded = true;
        return;
      }
      const nextParents = new Set([...parents, real]);
      for (const entry of fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        visited++;
        if (visited > 10000) {
          degraded = true;
          break;
        }
        const filename = path.join(directory, entry.name),
          name = path.posix.join(relative, entry.name);
        try {
          const actual = fs.realpathSync(filename);
          if (!inside(actual, realRoot)) {
            degraded = true;
            continue;
          }
          const stat = fs.statSync(actual);
          if (stat.isDirectory()) {
            walk(filename, name, nextParents, depth + 1);
            continue;
          }
          if (!stat.isFile() || !entry.name.endsWith(".sh")) continue;
          const scriptRef = `input:scripts/${name}`;
          try {
            resolveSetupScript(root, scriptRef);
            result.items.push({
              scriptRef,
              displayName: name,
              relativePath: name,
              availability: "AVAILABLE"
            });
          } catch (error) {
            degraded = true;
            result.items.push({
              scriptRef,
              displayName: name,
              relativePath: name,
              availability: "UNAVAILABLE",
              reason: String(error)
            });
          }
        } catch {
          degraded = true;
        }
      }
    };
    walk(root, "", new Set(), 0);
    result.state = degraded ? "DEGRADED" : result.items.length ? "READY" : "EMPTY";
  } catch (error) {
    result.state = "FAILED";
    result.reason = String(error);
  }
  return result;
}
