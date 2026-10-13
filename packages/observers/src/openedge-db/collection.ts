/** A metrics scrape observes the database now; health probes may reuse recent evidence.
 * Independent refresh/scrape timers can otherwise repeat an explicit native timestamp
 * and lose the intervening snapshot when their relative timing changes. */
export class DatabaseObserverCollection<T> {
  private snapshot?: { payload: T; completedAt: number };
  private collection?: Promise<T>;

  constructor(
    private readonly read: () => Promise<T>,
    private readonly healthFreshnessMs: number,
    private readonly now: () => number = Date.now
  ) {}

  metrics(): Promise<T> {
    if (this.collection) return this.collection;
    this.collection = Promise.resolve()
      .then(this.read)
      .then((payload) => {
        this.snapshot = { payload, completedAt: this.now() };
        return payload;
      })
      .finally(() => {
        this.collection = undefined;
      });
    return this.collection;
  }

  health(): Promise<T> {
    if (this.collection) return this.collection;
    if (this.snapshot && this.now() - this.snapshot.completedAt < this.healthFreshnessMs)
      return Promise.resolve(this.snapshot.payload);
    return this.metrics();
  }
}
