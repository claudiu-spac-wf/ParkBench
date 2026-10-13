const fs = require("node:fs");
const path = require("node:path");
const { findRepositoryRoot } = require("./load-env.cjs");

function canonicalRoot(root, allowMissing = false) {
  const candidate = path.resolve(root || findRepositoryRoot());
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) throw new Error("path_root_unavailable");
    return fs.realpathSync(candidate);
  } catch {
    if (allowMissing) return candidate;
    throw new Error("path_root_unavailable");
  }
}

function resolveHostPath(input, options = {}) {
  if (typeof input !== "string" || !input || input.includes("\0"))
    throw new Error("path_setting_invalid");
  const absoluteInput = path.isAbsolute(input);
  const root = absoluteInput
    ? path.resolve(options.root || findRepositoryRoot())
    : canonicalRoot(options.root, options.allowMissingRoot === true);
  let current = absoluteInput ? path.parse(input).root : root;
  const rest = absoluteInput ? input.slice(path.parse(input).root.length) : input;
  const suffix = [];

  for (const segment of rest.split(path.sep)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (suffix.length) throw new Error("path_parent_missing");
      current = path.dirname(current);
      continue;
    }
    if (suffix.length) {
      suffix.push(segment);
      continue;
    }
    const candidate = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") {
        suffix.push(segment);
        continue;
      }
      if (error?.code === "ENOTDIR") throw new Error("path_not_directory");
      throw new Error("path_unreadable");
    }
    try {
      current = fs.realpathSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT" && stat.isSymbolicLink())
        throw new Error("path_symlink_dangling");
      if (error?.code === "ENOENT") throw new Error("path_missing");
      throw new Error("path_unreadable");
    }
  }

  const resolved = path.resolve(current, ...suffix);
  if (options.requireExisting && suffix.length) throw new Error("path_missing");
  if (options.allowedRoot) {
    const allowed = resolveHostPath(options.allowedRoot, { root });
    if (!isPathWithin(resolved, allowed)) throw new Error("path_outside_allowed_root");
  }
  return resolved;
}

function isPathWithin(candidate, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function mapHostPathToContainer(hostPath, hostRoot, containerRoot, options = {}) {
  if (!path.isAbsolute(containerRoot)) throw new Error("container_path_root_invalid");
  const root = options.root || findRepositoryRoot();
  const resolvedHostRoot = resolveHostPath(hostRoot, { root });
  const resolvedHostPath = resolveHostPath(hostPath, { root, allowedRoot: resolvedHostRoot });
  return path.join(path.resolve(containerRoot), path.relative(resolvedHostRoot, resolvedHostPath));
}

module.exports = {
  resolveHostPath,
  isPathWithin,
  mapHostPathToContainer,
  findRepositoryRoot: (start) => findRepositoryRoot(start)
};

if (require.main === module) {
  try {
    const args = process.argv.slice(2).filter((argument) => argument !== "--");
    const rootIndex = args.indexOf("--root");
    const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
    const allowedIndex = args.indexOf("--allowed-root");
    const allowedRoot = allowedIndex >= 0 ? args[allowedIndex + 1] : undefined;
    const containerIndex = args.indexOf("--map-to-container");
    const containerRoot = containerIndex >= 0 ? args[containerIndex + 1] : undefined;
    const existing = args.includes("--require-existing");
    const input = args.at(-1);
    if (!input || input.startsWith("--")) throw new Error("path_setting_required");
    if (containerRoot) {
      if (!allowedRoot) throw new Error("path_mapping_root_required");
      process.stdout.write(
        `${mapHostPathToContainer(input, allowedRoot, containerRoot, { root })}\n`
      );
      process.exit(0);
    }
    process.stdout.write(
      `${resolveHostPath(input, { root, allowedRoot, requireExisting: existing })}\n`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "path_setting_invalid");
    process.exitCode = 1;
  }
}
