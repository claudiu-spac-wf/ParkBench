/** Controllable local stage gates. Tests never depend on wall-clock sleeps. */
export class StageHarness {
  nowMs = 1_700_000_000_000;
  readonly events: Array<{ stage: string; atMs: number }> = [];
  private gates = new Map<string, { promise: Promise<void>; release(): void }>();
  advance(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("invalid_clock_advance");
    this.nowMs += ms;
  }
  hold(stage: string) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(stage, { promise, release });
  }
  release(stage: string) {
    this.gates.get(stage)?.release();
  }
  async enter(stage: string, durationMs = 0) {
    this.events.push({ stage, atMs: this.nowMs });
    await this.gates.get(stage)?.promise;
    this.advance(durationMs);
  }
}
