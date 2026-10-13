import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObserverCollectionTelemetry } from "../../packages/observers/src/telemetry";

describe("observer collection telemetry", () => {
  it("records collection duration and bounded success/failure outcomes", () => {
    const telemetry = new ObserverCollectionTelemetry();
    telemetry.record(0.125, "success", 100);
    telemetry.record(0.25, "failure", 101);
    const rendered = telemetry.render("openedge_db_v1");
    assert.match(rendered, /parkbench_observer_scrapes_total 1/);
    assert.match(rendered, /parkbench_observer_scrape_failures_total 1/);
    assert.match(
      rendered,
      /parkbench_observer_collection_duration_seconds\{kind="openedge_db_v1",outcome="failure"\} 0\.25/
    );
    assert.match(
      rendered,
      /parkbench_observer_collection_outcomes_total\{kind="openedge_db_v1",outcome="success"\} 1/
    );
    assert.match(
      rendered,
      /parkbench_observer_collection_outcomes_total\{kind="openedge_db_v1",outcome="failure"\} 1/
    );
  });

  it("maps unrecognized observer kinds to a bounded label", () => {
    const telemetry = new ObserverCollectionTelemetry();
    assert.match(telemetry.render("credential=secret"), /kind="other"/);
    assert.doesNotMatch(telemetry.render("credential=secret"), /secret/);
  });
});
