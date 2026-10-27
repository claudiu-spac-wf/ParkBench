import fs from "node:fs";
import path from "node:path";
import { nativeFixture } from "./fixtures";
import {
  COVERAGE,
  NATIVE_SUFFIX
} from "../../../packages/contracts/src/database-analysis-definitions";
export class FakeAnalysisRunner {
  events: string[] = [];
  silent = false;
  cleanupFailures = 0;
  executionError?: string;
  executionWarning = false;
  truncateOutput = false;
  storageFailure = false;
  creation: Promise<void> = Promise.resolve();
  release?: () => void;
  async execute(report: any, resource: any, callbacks: any) {
    this.events.push("creating");
    await this.creation;
    this.events.push("running");
    while (this.silent && !callbacks.cancelled() && !callbacks.closed())
      await new Promise((r) => setTimeout(r, 2));
    if (callbacks.closed()) return;
    if (this.storageFailure) throw new Error("report_storage_failed");
    for (const kind of COVERAGE[report.type])
      fs.writeFileSync(
        path.join(resource.directory, "raw", "report" + NATIVE_SUFFIX[kind]),
        nativeFixture(kind)
      );
    if (this.truncateOutput)
      fs.appendFileSync(path.join(resource.directory, "raw", "report.block.txt"), '"unfinished');
    if (this.executionError) throw new Error(this.executionError);
    if (callbacks.cancelled()) throw new Error("report_cancelled");
    return {
      version: "12.8.11",
      mounts: [],
      warnings: this.executionWarning ? ["report_execution_warning"] : []
    };
  }
  async cleanup(resource: any) {
    this.events.push("cleanup");
    if (this.cleanupFailures-- > 0) throw new Error("fixture_docker_unavailable");
  }
}

/** Controllable cleanup clock; native execution has no clock deadline. */
export class ManualReportClock {
  private current = Date.parse("2026-10-19T12:00:00Z");
  private sequence = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.current;
  setTimeout = (callback: () => void, ms: number) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.current + ms, callback });
    return id as any;
  };
  clearTimeout = (id: any) => {
    this.timers.delete(id);
  };
  advance(ms: number) {
    this.current += ms;
    for (const [id, timer] of this.timers)
      if (timer.at <= this.current) {
        this.timers.delete(id);
        timer.callback();
      }
  }
}
