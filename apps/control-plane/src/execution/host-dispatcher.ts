import { ReportRepository } from "../reports/repository";
/** Claims are durable and fenced. No TTL can expire active analysis. */
export class HostDispatcher {
  private listeners = new Set<() => void>();
  private enabled = true;
  constructor(readonly repository: ReportRepository) {}
  onAvailable(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  claimExperiment(id: string) {
    if (!this.enabled) throw new Error("host_execution_busy");
    const token = this.repository.claim("EXPERIMENT", id);
    if (!token) throw new Error("host_execution_busy");
    return token;
  }
  release(token: string) {
    if (this.repository.release(token)) this.wake();
  }
  canDispatchReports() {
    return this.enabled;
  }
  busy() {
    return !this.enabled || !!this.repository.currentClaim() || !!this.repository.oldest();
  }
  pause() {
    this.enabled = false;
  }
  resume() {
    this.enabled = true;
    this.wake();
  }
  wake() {
    if (this.enabled) for (const listener of this.listeners) queueMicrotask(listener);
  }
}
