import fs from "node:fs";
export function availableBytes(filePath: string): number {
  return fs.statfsSync(filePath).bavail * fs.statfsSync(filePath).bsize;
}
export function assertWritableDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const test = `${dir}/.write-test-${Date.now()}`;
  fs.writeFileSync(test, "ok");
  fs.unlinkSync(test);
}
