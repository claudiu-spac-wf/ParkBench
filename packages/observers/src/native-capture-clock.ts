import fs from "node:fs";

interface CaptureSchedule {
  cadenceMs: number;
  phases: Array<{ phase: string; startMs: number; endMs: number }>;
}

/** The owned clock carries the complete immutable schedule. Source captures can
 * be shared within one interval without depending on HTTP arrival alignment. */
export class NativeCaptureClock {
  private schedule?: CaptureSchedule;
  constructor(
    private readonly file: string | undefined,
    private readonly runId: string
  ) {}
  minimumCapturedAtMs(now = Date.now()): number | undefined {
    if (!this.schedule) this.schedule = this.read();
    if (!Number.isFinite(now) || !this.schedule) return undefined;
    const phase = this.schedule.phases.find((p) => now >= p.startMs && now < p.endMs);
    return phase
      ? phase.startMs +
          Math.floor((now - phase.startMs) / this.schedule.cadenceMs) * this.schedule.cadenceMs
      : undefined;
  }
  private read(): CaptureSchedule | undefined {
    if (!this.file || !this.runId) return undefined;
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        this.file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096) return undefined;
      const bytes = Buffer.alloc(4097),
        length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (length > 4096) return undefined;
      const value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (
        value.contractVersion !== "run-phase-clock.v1" ||
        value.runId !== this.runId ||
        value.continuous !== true ||
        !Number.isFinite(value.nativeDatabaseIntervalMs) ||
        value.nativeDatabaseIntervalMs <= 0 ||
        !Array.isArray(value.nativePhases) ||
        value.nativePhases.length !== 3
      )
        return undefined;
      const names = ["warmup", "measurement", "cooldown"];
      const phases = value.nativePhases.map((p: any) => ({
        phase: p.phase,
        startMs: p.startMs,
        endMs: p.endMs
      }));
      if (
        phases.some(
          (p: any, i: number) =>
            p.phase !== names[i] ||
            !Number.isFinite(p.startMs) ||
            !Number.isFinite(p.endMs) ||
            p.startMs < 0 ||
            p.endMs < p.startMs ||
            (i > 0 && p.startMs !== phases[i - 1].endMs)
        )
      )
        return undefined;
      return { cadenceMs: value.nativeDatabaseIntervalMs, phases };
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
