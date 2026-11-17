import { NativeCaptureClock } from "./native-capture-clock";

/** Acquire on the owned source clock, independently of HTTP arrival. The
 * collector still owns single-flight sharing and actual source timestamps. */
export class NativeCaptureScheduler {
  private lastSlot?: number;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly clock: Pick<NativeCaptureClock, "nextCaptureAtMs">,
    private readonly capture: (slot: number) => Promise<unknown>,
    private readonly now: () => number = Date.now
  ) {}
  start(): void {
    if (!this.closed && !this.timer && !this.pending) this.arm(0);
  }
  private arm(delay: number) {
    if (this.closed) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.poll().then((next) => this.arm(next));
      },
      Math.min(60000, Math.max(0, delay))
    );
    this.timer.unref();
  }
  /** One bounded attempt per slot. Failed or slow work is never backfilled. */
  async poll(): Promise<number> {
    if (this.closed) return 250;
    if (this.pending) {
      await this.pending;
      return this.delay();
    }
    const slot = this.clock.nextCaptureAtMs(this.now(), this.lastSlot);
    if (slot === undefined) return 250; // Clock may be published after readiness.
    if (slot > this.now()) return slot - this.now();
    this.lastSlot = slot;
    this.pending = Promise.resolve()
      .then(() => this.capture(slot))
      .then(
        () => undefined,
        () => undefined // Native collector records failure; never publish cached success.
      );
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
    return this.delay();
  }
  private delay() {
    const next = this.clock.nextCaptureAtMs(this.now(), this.lastSlot);
    return next === undefined ? 250 : Math.max(0, next - this.now());
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
