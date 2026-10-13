import { DASHBOARD_UIDS, resolveDashboardUid } from "./model";
/** Presentation-only resolution; historical artifacts and saved context ownership stay intact. */
export function resolveDashboardReferences(
  refs: Array<{ dashboardId: string; panelIds: string[] }>
): Array<{ dashboardId: string; panelIds: string[] }> {
  const output = new Map<string, string[]>();
  for (const ref of refs)
    for (const id of ref.panelIds) {
      let uid = resolveDashboardUid(ref.dashboardId);
      let panelId = id;
      const numeric = Number(id);
      if (ref.dashboardId === "parkbench-overview")
        panelId =
          (
            {
              latency: "legacy.benchmark-overview.1",
              throughput: "legacy.benchmark-overview.2",
              resources: "rs.db_cpu"
            } as Record<string, string>
          )[id] ?? id;
      if (Number.isInteger(numeric) && numeric > 0) {
        panelId = `legacy.${ref.dashboardId.replace("parkbench-", "")}.${numeric}`;
        if (ref.dashboardId === "parkbench-database-recovery-concurrency" && numeric >= 36)
          uid = DASHBOARD_UIDS.concurrency;
        if (ref.dashboardId === "parkbench-database-activity" && [11, 12].includes(numeric))
          uid = DASHBOARD_UIDS.concurrency;
        if (ref.dashboardId === "parkbench-database-activity" && numeric === 16)
          uid = DASHBOARD_UIDS.recovery;
      }
      const ids = output.get(uid) ?? [];
      ids.push(panelId);
      output.set(uid, ids);
    }
  return [...output].map(([dashboardId, panelIds]) => ({ dashboardId, panelIds }));
}
