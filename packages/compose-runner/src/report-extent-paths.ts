import path from "node:path";
import { StructureExtent } from "../../contracts/src/seed";
export function extentAliases(
  extents: Array<Pick<StructureExtent, "path" | "file">>,
  files: Set<string>,
  seedPath: string
): string[] {
  const targets = new Set<string>();
  for (const extent of extents) {
    if (!files.has(extent.file)) throw new Error("report_seed_extent_paths_unavailable");
    let target = extent.path;
    if (target.split(/[\\/]/).includes("..") || target.includes("\\"))
      throw new Error("report_seed_extent_paths_unavailable");
    if (path.posix.basename(target) === extent.file) target = path.posix.dirname(target);
    if (target === "." || target === "/seed") continue;
    if (!path.posix.isAbsolute(target)) {
      if (target !== ".") throw new Error("report_seed_extent_paths_unavailable");
      continue;
    }
    target = path.posix.normalize(target);
    const allowed = ["/seed", "/work", "/psc/wrk", seedPath.replace(/\\/g, "/")].filter(
      (p) => p !== "/"
    );
    if (
      !allowed.some((p) => target === p || target.startsWith(p + "/")) &&
      !/^\/tmp\/[^/]+(?:\/.*)?$/.test(target)
    )
      throw new Error("report_seed_extent_paths_unavailable");
    if (
      ["/reports", "/psc/dlc", "/usr", "/bin", "/var", "/run"].some(
        (p) => target === p || target.startsWith(p + "/")
      )
    )
      throw new Error("report_seed_extent_paths_unavailable");
    targets.add(target);
  }
  return [...targets].sort();
}
