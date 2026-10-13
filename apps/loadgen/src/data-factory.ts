export class DataFactory {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  record(prefix = "record"): Record<string, string | number> {
    return {
      name: `${prefix}-${Math.floor(this.next() * 1e9)}`,
      value: Math.floor(this.next() * 1e6),
      sequence: Math.floor(this.next() * 1e9)
    };
  }
}
