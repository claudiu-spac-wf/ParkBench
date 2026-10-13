import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Storage placement is irrelevant to compilation. Keep every declared area name, but create
// only minimal empty extents; never import seed data or its allocated extent sizes.
export function compilerStructure(definitions) {
  const areas = new Set(["Schema Area"]);
  for (const match of definitions.matchAll(/^\s*(?:AREA|LOB-AREA)\s+"([^"]+)"\s*$/gm)) {
    if (!/^[A-Za-z0-9_ .-]{1,80}$/.test(match[1])) throw new Error("compile_schema_area_invalid");
    areas.add(match[1]);
  }
  if (areas.size > 256) throw new Error("compile_schema_area_limit");
  return "b .\n" + [...areas].map((area, index) => `d "${area}":${index + 6},32;1 .\n`).join("");
}

export function resolveCompilerSchema(file, root = process.cwd()) {
  if (!file?.trim()) throw new Error("compile_schema_required:PARKBENCH_OPENEDGE_COMPILE_SCHEMA");
  const schemaFile = path.resolve(root, file);
  let definitions;
  try {
    if (!fs.statSync(schemaFile).isFile() || path.extname(schemaFile).toLowerCase() !== ".df")
      throw new Error("not_definition_file");
    if (fs.statSync(schemaFile).size > 16 * 1024 * 1024) throw new Error("schema_too_large");
    definitions = fs.readFileSync(schemaFile);
  } catch {
    throw new Error("compile_schema_missing:PARKBENCH_OPENEDGE_COMPILE_SCHEMA");
  }
  const text = definitions.toString("utf8");
  if (!/^ADD\s+(?:TABLE|FIELD|SEQUENCE)\s+/m.test(text)) throw new Error("compile_schema_invalid");
  return {
    schemaFile,
    sha256: createHash("sha256").update(definitions).digest("hex"),
    structure: compilerStructure(text)
  };
}
