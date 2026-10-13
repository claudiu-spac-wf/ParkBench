import fs from "node:fs";
import path from "node:path";
import { MetricLabels } from "../../contracts/src/metrics";
export interface DiscoveryTarget {
  targets: string[];
  labels: Omit<MetricLabels, "phase"> & { phase?: MetricLabels["phase"] } & Record<
      string,
      string | undefined
    >;
}
export class FileDiscovery {
  constructor(public readonly filePath: string) {}
  write(targets: DiscoveryTarget[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(targets, null, 2));
    fs.renameSync(temporary, this.filePath);
  }
  clear(): void {
    this.write([]);
  }
  add(runId: string, targets: DiscoveryTarget[]): void {
    const remaining = this.read().filter((target) => target.labels.run_id !== runId);
    this.write([...remaining, ...targets]);
  }
  remove(runId: string): void {
    const remaining = this.read().filter((target) => target.labels.run_id !== runId);
    if (remaining.length === 0) fs.rmSync(this.filePath, { force: true });
    else this.write(remaining);
    if (this.read().some((target) => target.labels.run_id === runId))
      throw new Error(`target_file_cleanup_verification_failed:${runId}`);
  }
  updatePhase(runId: string, phase: string): void {
    this.write(
      this.read().map((target) =>
        target.labels.run_id === runId
          ? { ...target, labels: { ...target.labels, phase: phase as MetricLabels["phase"] } }
          : target
      )
    );
  }
  read(): DiscoveryTarget[] {
    return fs.existsSync(this.filePath) ? JSON.parse(fs.readFileSync(this.filePath, "utf8")) : [];
  }

  activeRunId(): string | undefined {
    return this.read().find((target) => target.labels.run_id)?.labels.run_id;
  }
}
export function activeScrapeInterval(active: boolean): number {
  return active ? 1 : 15;
}

export function resolveRequestedRunId(
  requested: unknown,
  lookup: (id: string) => unknown,
  active: () => string | undefined
): string | undefined {
  if (requested === undefined) return active();
  if (typeof requested !== "string" || !lookup(requested)) throw new Error("run_not_found");
  return requested;
}
