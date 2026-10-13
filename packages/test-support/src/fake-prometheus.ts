import { MemoryPrometheusClient } from "../../metrics/src/prometheus-client";
import { fakeSamples } from "./fake-observers";
export function fakePrometheus(runId = "run_fake"): MemoryPrometheusClient {
  return new MemoryPrometheusClient(fakeSamples(runId));
}
