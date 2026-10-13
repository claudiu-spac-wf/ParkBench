import fs from "node:fs";
export function signalCancellation(file: string): void {
  fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
  fs.writeFileSync(file, new Date().toISOString());
}
export function cancellationRequested(file: string): boolean {
  if (!file) return false;
  try {
    const stats = fs.statSync(file);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}
