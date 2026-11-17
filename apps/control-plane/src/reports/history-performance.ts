/** Reporting projections only; these never change source records or run validity. */
export function recordOperation(scenario: any): "read" | "write" {
  const operations = (scenario.workload?.operations ?? []).filter((op: any) => op.weight > 0);
  if (
    operations.some(
      (op: any) =>
        /\/write\//i.test(op.bodyTemplate?.procName ?? "") ||
        ["create", "update", "delete", "write"].includes(
          String(op.bodyTemplate?.input?.Operation ?? "").toLowerCase()
        ) ||
        op.bodyTemplate?.input?.op === "audit-write-cycle"
    )
  )
    return "write";
  if (
    operations.length &&
    operations.every(
      (op: any) =>
        /reads?\b|\/read\//i.test(op.bodyTemplate?.procName ?? "") ||
        ["reference-point", "selective", "range"].includes(op.bodyTemplate?.input?.op)
    )
  )
    return "read";
  throw Error("unknown_scenario_record_operation:" + scenario.id);
}
export function latchCategory(name: string): string {
  return name.replace(/^MTL_/, "").replace(/^(.+?\D)\d+$/, "$1N");
}
export function topLatchCategories(
  rows: Array<{ name: string; waits: number | null; coverage?: string }>
) {
  const groups = new Map<
    string,
    { category: string; waits: number; supported: number; partial: boolean }
  >();
  for (const row of rows) {
    const category = latchCategory(row.name),
      group = groups.get(category) ?? { category, waits: 0, supported: 0, partial: false };
    if (row.waits !== null && Number.isFinite(row.waits) && row.waits >= 0) {
      group.waits += row.waits;
      group.supported++;
    } else group.partial = true;
    group.partial ||= row.coverage === "partial" || row.coverage === "unavailable";
    groups.set(category, group);
  }
  return [...groups.values()]
    .filter((g) => g.supported)
    .sort((a, b) => b.waits - a.waits || a.category.localeCompare(b.category))
    .slice(0, 4)
    .map((g) => ({
      category: g.category,
      waits: g.waits,
      coverage: g.partial ? "partial" : "complete"
    }));
}
interface BufferGroup {
  logical: Array<[number, number | null]>;
  physical: Array<[number, number | null]>;
}
/** Both numerators use exactly the same observed intervals, within one pool and
 * epoch. Missing acquisitions and unavailable fields break, rather than fill, a segment. */
export function pairedBufferHits(
  groups: BufferGroup[],
  start: number,
  end: number,
  cadence: number
) {
  let logical = 0,
    physical = 0,
    intervals = 0,
    seconds = 0,
    partial = groups.length > 1,
    first = Infinity,
    last = -Infinity;
  for (const group of groups) {
    const l = new Map(group.logical),
      p = new Map(group.physical);
    const times = [...new Set([...l.keys(), ...p.keys()])]
      .filter((t) => t >= start && t <= end)
      .sort((a, b) => a - b);
    let previous: [number, number, number] | undefined;
    for (const t of times) {
      const lv = l.get(t),
        pv = p.get(t);
      if (
        lv === null ||
        pv === null ||
        lv === undefined ||
        pv === undefined ||
        !Number.isFinite(lv) ||
        !Number.isFinite(pv) ||
        lv < 0 ||
        pv < 0
      ) {
        previous = undefined;
        partial = true;
        continue;
      }
      first = Math.min(first, t);
      last = Math.max(last, t);
      if (previous) {
        if (t > previous[0] && t - previous[0] <= cadence * 1.5) {
          logical += lv >= previous[1] ? lv - previous[1] : lv;
          physical += pv >= previous[2] ? pv - previous[2] : pv;
          seconds += t - previous[0];
          intervals++;
        } else partial = true;
      }
      previous = [t, lv, pv];
    }
  }
  partial ||= first - start > cadence * 1.1 || end - last > cadence * 1.1;
  const ratio =
    intervals && logical > 0 && physical <= logical ? (logical - physical) / logical : null;
  return {
    ratio,
    logical,
    physical,
    observedSeconds: seconds,
    intervals,
    coverage: ratio === null ? "unavailable" : partial ? "partial" : "observed"
  };
}
export function appliedRunParameters(run: any, snapshot: any) {
  const e = run.environmentSnapshot ?? {},
    effective = e.effectiveConfiguration ?? {};
  const observed = new Map<string, any>(
    (snapshot?.rows ?? [])
      .filter((r: any) => r.valueStatus === "recorded")
      .map((r: any) => [r.name, r.displayValue ?? r.numericValue])
  );
  const unverified: string[] = [];
  const parameterKeys = [
    ...new Set([
      ...Object.keys(effective).filter((k) => k.startsWith("-")),
      ...["-B", "-B2", "-spin", "-lruskips"].filter((k) => observed.has(k))
    ])
  ];
  const parts = parameterKeys
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((k) => {
      const found = observed.has(k);
      if (!found) unverified.push(k);
      return `${k}=${found ? observed.get(k) : effective[k]}${found ? "" : " (configured)"}`;
    });
  const control = e.databaseRunControlEvidence,
    actual = control?.lastSuccessfulObservation ?? control?.observed;
  if (actual) {
    if (actual.biBuffers !== undefined) {
      const i = parts.findIndex((p) => p.startsWith("-bibufs="));
      if (i >= 0) parts.splice(i, 1);
      const u = unverified.indexOf("-bibufs");
      if (u >= 0) unverified.splice(u, 1);
      parts.push(`-bibufs=${actual.biBuffers}`);
    }
    if (actual.apwCount !== undefined) parts.push(`APW=${actual.apwCount}`);
    if (actual.biwCount !== undefined) parts.push(`BIW=${actual.biwCount ? "on" : "off"}`);
    if (actual.nativeClusterKiB !== undefined)
      parts.push(`BI cluster=${actual.nativeClusterKiB / 1024} MiB`);
  } else if (e.databaseRunControls) {
    const c = e.databaseRunControls;
    parts.push(`APW=${c.apwCount} (configured)`, `BIW=${c.biwEnabled ? "on" : "off"} (configured)`);
    if (c.biCluster?.requestedMiB !== undefined)
      parts.push(`BI cluster=${c.biCluster.requestedMiB} MiB (configured)`);
  }
  if (e.databaseSetup?.steps?.length)
    parts.push(
      "Setup: " +
        e.databaseSetup.steps
          .map(
            (step: any) =>
              step.definitionId +
              "(" +
              step.optionSets
                .map((o: any) => [o.table, o.useIndex ?? o.index].filter(Boolean).join("/"))
                .filter(Boolean)
                .join(", ") +
              ")"
          )
          .join("; ")
    );
  return { text: parts.join("; "), unverified, snapshotStatus: snapshot?.status ?? "not captured" };
}
