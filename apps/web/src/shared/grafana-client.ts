import { DASHBOARD_CATALOG, resolveDashboardUid } from "../../../../packages/dashboards/src/model";
export { resolveDashboardUid };
export interface GrafanaDashboard {
  uid: string;
  title: string;
  folderTitle?: string;
  folderUid?: string;
}

async function grafanaJson(route: string): Promise<unknown> {
  const response = await fetch(`/grafana-api/${route}`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`grafana_${route.split(/[/?]/)[0]}_unavailable`);
  return response.json();
}

/** Every dashboard Grafana has, in the order Grafana's search returns them. */
export async function getGrafanaDashboards(): Promise<GrafanaDashboard[]> {
  const body = await grafanaJson("search?type=dash-db");
  if (!Array.isArray(body)) throw new Error("grafana_search_invalid_response");
  return body.filter(
    (dashboard): dashboard is GrafanaDashboard =>
      dashboard !== null &&
      typeof dashboard === "object" &&
      typeof dashboard.uid === "string" &&
      dashboard.uid !== "" &&
      typeof dashboard.title === "string"
  );
}

/** Group managed folders first, preserving discovery order inside every group. */
export function groupGrafanaDashboards(
  dashboards: GrafanaDashboard[]
): Array<{ title: string; dashboards: GrafanaDashboard[] }> {
  const groups = new Map<string, GrafanaDashboard[]>();
  for (const dashboard of dashboards) {
    const title =
      dashboard.folderTitle ??
      DASHBOARD_CATALOG.find((e) => e.uid === dashboard.uid)?.folder ??
      "Other";
    const group = groups.get(title) ?? [];
    group.push(dashboard);
    groups.set(title, group);
  }
  return [...new Set(["Resources", "Database", "PAS", ...groups.keys()])]
    .filter((title) => groups.has(title))
    .map((title) => ({ title, dashboards: groups.get(title)! }));
}
