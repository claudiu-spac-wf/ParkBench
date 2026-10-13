import { Scope } from "./model";

/** Normal ("ambient") scrape jobs; run-tagged duplicate scrapes are never selected (R10). */
export const HOST_AMBIENT_JOB = "node-exporter";
export const PLATFORM_AMBIENT_JOB = "cadvisor";
export const RUN_CONTAINER_JOB = "parkbench-run-owned-cadvisor";

/** Host core count, a run-independent reference selector (contract R1 exemption). */
export const HOST_CORES = `count(node_cpu_seconds_total{job="${HOST_AMBIENT_JOB}",mode="idle"})`;

/** Label that identifies a container within each scope. */
export function containerLabel(scope: Exclude<Scope, "host">): string {
  return scope === "platform" ? "container_label_com_docker_compose_service" : "service";
}

/** Label matchers (without braces) that restrict a container series to a scope. */
export function containerMatchers(scope: Exclude<Scope, "host">): string {
  switch (scope) {
    case "platform":
      return `job="${PLATFORM_AMBIENT_JOB}",container_label_com_docker_compose_project="parkbench-platform",container_label_com_docker_compose_service!=""`;
    case "db":
      return `job="${RUN_CONTAINER_JOB}",run_id=~"$run_id",service="database"`;
    case "run":
      return `job="${RUN_CONTAINER_JOB}",run_id=~"$run_id",service!="database",service!=""`;
  }
}

export function hostMatchers(): string {
  return `job="${HOST_AMBIENT_JOB}"`;
}

/** Run-scoped scopes partition every ranking and aggregate by run. */
export function isRunScoped(scope: Scope): boolean {
  return scope === "db" || scope === "run";
}
