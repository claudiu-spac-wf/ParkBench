import { MetricSample } from "../../contracts/src/metrics";
import { ResourceMembership, ResourceGroup } from "../../contracts/src/metric-definitions";
import type { Run } from "../../contracts/src/run";
export interface ExpectedResourceMember {
  group: ResourceGroup;
  service: string;
  replica?: string;
}
export function expectedResourceMembers(
  run: Run,
  resources: Array<Record<string, any>> = []
): ExpectedResourceMember[] {
  const names = new Set<string>();
  const platformNames = new Set<string>();
  const scenario = (run.environmentSnapshot as any)?.scenario;
  if (scenario?.target) {
    names.add("database");
    for (let i = 1; i <= Number(scenario.target.pasReplicas ?? 1); i++) names.add(`pas-${i}`);
  }
  for (const resource of resources) {
    if (resource.resourceType !== "container") continue;
    const service =
      resource.labels?.["com.docker.compose.service"] ??
      resource.labels?.service ??
      resource.resourceId;
    if (service === "database" || /^pas-\d+$/.test(service)) names.add(service);
    else if (resource.labels?.["com.docker.compose.project"] === "parkbench-platform")
      platformNames.add(service);
  }
  return [...names]
    .sort()
    .map((service) => ({
      group: (service === "database" ? "database" : "pas") as ResourceGroup,
      service,
      ...(service === "database" ? {} : { replica: service })
    }))
    .concat(
      [...platformNames].sort().map((service) => ({ group: "platform" as ResourceGroup, service }))
    );
}
export function missingResourceMembers(
  expected: ExpectedResourceMember[],
  observed: ResourceMembership[]
): ExpectedResourceMember[] {
  return expected.filter(
    (e) => !observed.some((m) => m.group === e.group && m.service === e.service)
  );
}
export function physicalIdentity(sample: MetricSample): string | undefined {
  const id = sample.labels.id ?? sample.labels.container_id;
  if (!id || id === "/" || id.endsWith("/")) return undefined;
  return id;
}
export function parentCgroups(samples: MetricSample[]): Set<string> {
  const parents = new Set<string>();
  for (const sample of samples) {
    const id = physicalIdentity(sample);
    if (!id) continue;
    let position = id.lastIndexOf("/");
    while (position > 0) {
      parents.add(id.slice(0, position));
      position = id.lastIndexOf("/", position - 1);
    }
  }
  return parents;
}
export function resourceGroup(sample: MetricSample): ResourceGroup | undefined {
  const service = sample.labels.service ?? sample.labels.container_label_com_docker_compose_service;
  const runId = sample.labels.run_id ?? sample.labels.container_label_parkbench_run_id;
  if (runId) {
    if (service === "database") return "database";
    if (/^pas-\d+$/.test(service ?? "")) return "pas";
    return undefined;
  }
  if (sample.labels.container_label_com_docker_compose_project === "parkbench-platform")
    return "platform";
  return undefined;
}
export function resolveResourceMembership(
  samples: MetricSample[],
  runId: string,
  start: number,
  end: number,
  sourceStepSeconds: number,
  resources: Array<Record<string, any>> = [],
  uncachedEvidence = false,
  sourceTimestampLagSeconds = 0
): ResourceMembership[] {
  if (!Number.isFinite(sourceTimestampLagSeconds) || sourceTimestampLagSeconds < 0)
    throw new Error("source_acquisition_lag_invalid");
  const freshnessSeconds = sourceStepSeconds + sourceTimestampLagSeconds;
  const known = resources
    .filter((r) => r.resourceType === "container")
    .map((r) => String(r.resourceId));
  const parents = parentCgroups(samples);
  const members = new Map<
    string,
    {
      member: ResourceMembership;
      times: number[];
      birth?: number;
      knownOwned: boolean;
      verifiedService: boolean;
    }
  >();
  for (const sample of samples) {
    const physicalId = physicalIdentity(sample),
      group = resourceGroup(sample);
    if (
      !physicalId ||
      parents.has(physicalId) ||
      !group ||
      sample.timestamp < start ||
      sample.timestamp > end
    )
      continue;
    const tagged = sample.labels.run_id ?? sample.labels.container_label_parkbench_run_id;
    if (group !== "platform" && tagged !== runId) continue;
    const service =
      sample.labels.service ??
      sample.labels.container_label_com_docker_compose_service ??
      "unknown";
    // Compose inventory identifies services; cAdvisor identifies physical cgroups.
    // Only verified Docker ownership may bridge those two identities.
    const verifiedService =
      sample.labels.container_label_parkbench_managed === "true" &&
      sample.labels.container_label_parkbench_run_id === runId &&
      sample.labels.container_label_com_docker_compose_service === service;
    const knownOwned = known.some(
      (id) =>
        physicalId === id ||
        physicalId.endsWith("/" + id) ||
        physicalId.endsWith(id + ".scope") ||
        (verifiedService && id === service)
    );
    if (known.length && group !== "platform" && !knownOwned) continue;
    const birth =
      sample.metricName === "container_start_time_seconds" && Number.isFinite(sample.value)
        ? sample.value
        : undefined;
    const epoch = sample.labels.epoch ?? (birth === undefined ? physicalId : String(birth)),
      key = JSON.stringify([group, physicalId, epoch]);
    let entry = members.get(key);
    if (!entry) {
      entry = {
        member: {
          group,
          service,
          ...(group === "pas" ? { replica: service } : {}),
          physicalId,
          epoch,
          activeIntervals: [],
          sourceJob:
            sample.labels.job ??
            (group === "platform" ? "cadvisor" : "parkbench-run-owned-cadvisor"),
          sourceStepSeconds,
          ...(uncachedEvidence
            ? { freshness: { kind: "uncached_scrape", latencySeconds: freshnessSeconds } }
            : {})
        },
        times: [],
        birth,
        knownOwned,
        verifiedService
      };
      members.set(key, entry);
    }
    entry.times.push(sample.timestamp);
  }
  for (const { member, times, birth, knownOwned } of members.values()) {
    const sorted = [...new Set(times)].sort((a, b) => a - b),
      first = sorted[0],
      last = sorted.at(-1)!;
    // An unchanged native birth epoch spans internal missed scrapes. Its resource
    // observations must expose those gaps rather than treating the member as absent.
    const firstSupported =
      birth !== undefined && birth <= start && first - start <= freshnessSeconds ? start : first;
    member.activeIntervals.push({
      start: Math.max(
        start,
        knownOwned && birth !== undefined ? birth : firstSupported,
        birth ?? start
      ),
      end: knownOwned ? end : Math.min(end, last + freshnessSeconds)
    });
  }
  const ordered = [...members.values()].sort((a, b) => Math.min(...a.times) - Math.min(...b.times));
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index];
    const replacement = ordered
      .slice(index + 1)
      .find(
        (next) =>
          (next.member.physicalId === entry.member.physicalId &&
            next.member.epoch !== entry.member.epoch) ||
          (next.member.physicalId !== entry.member.physicalId &&
            next.member.group === entry.member.group &&
            next.member.service === entry.member.service &&
            next.member.sourceJob === entry.member.sourceJob &&
            entry.verifiedService &&
            next.verifiedService &&
            known.includes(entry.member.service) &&
            entry.birth !== undefined &&
            next.birth !== undefined &&
            next.birth > entry.birth &&
            Math.min(...next.times) - next.birth <= sourceStepSeconds &&
            Math.max(...entry.times) < next.birth)
      );
    if (replacement) {
      // A newer native birth for the inventory's singleton logical service, with no
      // old observation at/after that birth, is a verified recreation. Otherwise
      // preserve concurrent members/unknown-stop gaps. Never infer an early stop
      // merely from the old stream's last observed sample.
      const boundary =
        replacement.member.physicalId === entry.member.physicalId
          ? Math.min(...replacement.times)
          : replacement.birth!;
      entry.member.activeIntervals = entry.member.activeIntervals
        .map((i) => ({ ...i, end: Math.min(i.end, boundary) }))
        .filter((i) => i.end >= i.start);
    }
  }
  return ordered
    .map((e) => e.member)
    .filter((m) => m.activeIntervals.some((i) => i.end >= i.start));
}
