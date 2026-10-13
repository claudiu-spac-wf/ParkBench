/** Choose one representation per physical container before scope aggregation. */
export function containerCpuActivity(
  matchers: string,
  window: string = "[$__rate_interval]",
  functionName: "rate" | "increase" = "rate"
): string {
  const by = "run_id, id, service, container_label_com_docker_compose_service";
  const activity = (cpu: string) => {
    const selector = `container_cpu_usage_seconds_total{${matchers},${cpu}}`;
    const values = `${functionName}(${selector}${window})`;
    return functionName === "rate" ? freshestContainerReading(selector, values, "cpu") : values;
  };
  const total = `${functionName === "rate" ? "max" : "sum"} by (${by}) (${activity('cpu=~"total|"')})`;
  const cores = `sum by (${by}) (${activity('cpu!~"total|"')})`;
  return `(${total} or on (run_id, id) (${cores} unless on (run_id, id) ${total}))`;
}
export function containerCpuPercent(matchers: string, by: string): string {
  return `100 * sum by (${by}) (${containerCpuActivity(matchers)})`;
}
import { freshestContainerReading } from "./container-reading";
