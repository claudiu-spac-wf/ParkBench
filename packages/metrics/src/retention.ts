export function prometheusRetention(
  value = process.env.PARKBENCH_PROMETHEUS_RETENTION ?? "7d"
): string {
  return value;
}
