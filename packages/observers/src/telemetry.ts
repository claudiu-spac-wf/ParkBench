const OBSERVER_KINDS = new Set(["openedge_db_v1", "openedge_pas_v1", "file_sampler_v1", "http_v1"]);

export class ObserverCollectionTelemetry {
  private scrapes = 0;
  private failures = 0;
  private lastSuccess = 0;
  private lastDurationSeconds = 0;
  private lastOutcome: "success" | "failure" = "success";
  private readonly outcomes = { success: 0, failure: 0 };

  record(durationSeconds: number, outcome: "success" | "failure", nowSeconds = Date.now() / 1000) {
    this.lastDurationSeconds = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
    this.lastOutcome = outcome;
    this.outcomes[outcome] += 1;
    if (outcome === "success") {
      this.scrapes += 1;
      this.lastSuccess = nowSeconds;
    } else this.failures += 1;
  }

  render(kind: string): string {
    const safeKind = OBSERVER_KINDS.has(kind) ? kind : "other";
    const lines = [
      "# TYPE parkbench_observer_scrapes_total counter",
      `parkbench_observer_scrapes_total ${this.scrapes}`,
      "# TYPE parkbench_observer_scrape_failures_total counter",
      `parkbench_observer_scrape_failures_total ${this.failures}`,
      "# TYPE parkbench_observer_last_success_timestamp_seconds gauge",
      `parkbench_observer_last_success_timestamp_seconds ${this.lastSuccess}`,
      "# TYPE parkbench_observer_collection_duration_seconds gauge",
      `parkbench_observer_collection_duration_seconds{kind=\"${safeKind}\",outcome=\"${this.lastOutcome}\"} ${this.lastDurationSeconds}`,
      "# TYPE parkbench_observer_collection_outcomes_total counter",
      `parkbench_observer_collection_outcomes_total{kind=\"${safeKind}\",outcome=\"success\"} ${this.outcomes.success}`,
      `parkbench_observer_collection_outcomes_total{kind=\"${safeKind}\",outcome=\"failure\"} ${this.outcomes.failure}`
    ];
    return `${lines.join("\n")}\n`;
  }
}
