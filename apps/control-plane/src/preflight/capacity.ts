import os from "node:os";
import fs from "node:fs";
export function hostCapacity(root = process.cwd()) {
  const stat: any = fs.statfsSync(root);
  return { cpu: os.cpus().length, memoryBytes: os.totalmem(), freeBytes: stat.bavail * stat.bsize };
}
