import fs from "node:fs";
import path from "node:path";
import { DatabaseSetupManifest } from "../../../../packages/contracts/src/database-setup";
import { resolveSetupScript } from "./scripts";
/** Copy through an opened regular file; chmod only the attempt-owned destination. */
export function stageSetupScripts(manifest: DatabaseSetupManifest, configuredRoot?: string) {
  const refs = [
    ...new Set(
      manifest.sequence.steps.flatMap((step) =>
        step.definitionId === "custom" ? [step.scriptRef] : []
      )
    )
  ];
  for (const scriptRef of refs) {
    const resolved = resolveSetupScript(configuredRoot, scriptRef);
    let source: number | undefined, destination: number | undefined;
    const stagedPath = path.join(manifest.paths.input, "scripts", resolved.relativePath);
    try {
      source = fs.openSync(resolved.sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(source).isFile()) throw new Error("regular_file_required");
      const opened = fs.realpathSync(`/proc/self/fd/${source}`);
      if (opened !== resolved.root && !opened.startsWith(resolved.root + path.sep))
        throw new Error("outside_root");
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      destination = fs.openSync(stagedPath, "wx", 0o755);
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      while ((bytes = fs.readSync(source, buffer, 0, buffer.length, null)) > 0) {
        let offset = 0;
        while (offset < bytes) offset += fs.writeSync(destination, buffer, offset, bytes - offset);
      }
      fs.fchmodSync(destination, 0o755);
      fs.fsyncSync(destination);
      manifest.scripts.push({
        scriptRef,
        sourcePath: resolved.sourcePath,
        stagedPath,
        capturedAt: new Date().toISOString()
      });
    } catch (error) {
      throw new Error(`database_setup_script_unavailable:${scriptRef}:${String(error)}`);
    } finally {
      if (source !== undefined) fs.closeSync(source);
      if (destination !== undefined) fs.closeSync(destination);
    }
  }
}
