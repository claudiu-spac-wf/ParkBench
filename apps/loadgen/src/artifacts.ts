import fs from "node:fs";
export function writeSummary(
  file: string,
  summary: unknown
): { path: string; sizeBytes: number } {
  fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
  const content = JSON.stringify(summary, null, 2);
  fs.writeFileSync(file, content);
  return {
    path: file,
    sizeBytes: Buffer.byteLength(content)
  };
}
